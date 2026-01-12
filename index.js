/**
 * Email MCP Server
 * 
 * Sends customer support emails to HubSpot Conversations inbox via forwarding.
 * Emails are sent to customer with HubSpot inbox BCC'd for ticket creation.
 * 
 * Required env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   HUBSPOT_BCC_EMAIL (the hosted email, e.g., support@youraccount.hs-inbox.com)
 *   HUBSPOT_ACCESS_TOKEN (private app token with conversations.write)
 *   HUBSPOT_INBOX_ID (numeric inbox ID for thread lookup)
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function toTimestamp(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function pickMostRecentThread(threads) {
  if (!threads.length) return null;
  return [...threads].sort((a, b) => {
    const aTs = toTimestamp(a.latestMessageTimestamp || a.updatedAt || a.createdAt);
    const bTs = toTimestamp(b.latestMessageTimestamp || b.updatedAt || b.createdAt);
    return bTs - aTs;
  })[0];
}

function pickThreadBySubject(threads, subject) {
  if (!subject) return pickMostRecentThread(threads);
  const normalizedSubject = subject.toLowerCase();
  const subjectMatches = threads.filter((thread) => {
    const threadSubject = typeof thread.subject === "string" ? thread.subject.toLowerCase() : "";
    return threadSubject.includes(normalizedSubject);
  });
  return pickMostRecentThread(subjectMatches.length ? subjectMatches : threads);
}

async function hubspotRequest(path, { method = "GET", body } = {}) {
  const hubspotAccessToken = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!hubspotAccessToken) {
    throw new Error("HUBSPOT_ACCESS_TOKEN not configured");
  }

  const response = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${hubspotAccessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HubSpot API error ${response.status}: ${errorBody}`);
  }

  return response.json();
}

async function findThreadIdByInbox({ inboxId, latestMessageTimestampAfter, subject }) {
  const params = new URLSearchParams({
    inboxId: String(inboxId),
    sort: "latestMessageTimestamp",
    latestMessageTimestampAfter: String(latestMessageTimestampAfter),
    limit: "20",
  });

  const data = await hubspotRequest(`/conversations/v3/conversations/threads?${params.toString()}`);
  const threads = Array.isArray(data.results) ? data.results : [];
  const thread = pickThreadBySubject(threads, subject);
  return thread?.id || null;
}

async function postInternalComment({ threadId, text, richText }) {
  return hubspotRequest(`/conversations/v3/conversations/threads/${threadId}/messages`, {
    method: "POST",
    body: {
      type: "COMMENT",
      text,
      richText,
    },
  });
}

function analyzeConversationForSupport(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return { action: "no_action", reason: "No conversation history provided" };
  }

  const lastMessages = conversationHistory.slice(-4).map(m => m.content.toLowerCase());
  
  const explicitSupportRequest = lastMessages.some(msg => 
    /support|agent|speak with|contact|help team|representative|specialist|support ticket/.test(msg)
  );

  if (explicitSupportRequest) {
    return { 
      action: "offer_or_create_ticket", 
      reason: "Customer explicitly requested support",
      urgency: "high"
    };
  }

  const negativeResponse = lastMessages.some(msg =>
    /^(no|didn't help|doesn't work|still broken|still doesn't|nope|nah|didn't solve|doesn't solve)/.test(msg) ||
    /didn't (help|work|solve)|doesn't (help|work|solve)|not (helpful|working)|still (broken|failing|doesn't)/.test(msg)
  );

  if (negativeResponse) {
    return {
      action: "offer_or_create_ticket",
      reason: "Customer indicated suggested solution did not help",
      urgency: "high"
    };
  }

  const confusionOrError = lastMessages.some(msg =>
    /error|failed|broken|stuck|confused|not sure|unclear|doesn't show|missing|not (working|appearing)|crash|freeze|hang/.test(msg)
  );

  if (confusionOrError && conversationHistory.length >= 3) {
    return {
      action: "offer_ticket",
      reason: "Customer appears to be experiencing technical issues",
      urgency: "medium"
    };
  }

  const uncertainResponse = lastMessages.some(msg =>
    /\?$|what if|what about|how do i|can't figure|not clear|still don't|what do you mean|don't understand|what's|how's/.test(msg)
  );

  if (uncertainResponse && conversationHistory.length >= 4) {
    return {
      action: "offer_ticket",
      reason: "Customer appears uncertain and may need direct assistance",
      urgency: "medium"
    };
  }

  const positiveResponse = lastMessages.some(msg =>
    /^(yes|yep|yeah|yup|thanks|that works|solved|fixed|great|perfect|ok|good)/.test(msg) ||
    /works|solved|fixed|helpful|thanks/.test(msg)
  );

  if (positiveResponse) {
    return {
      action: "no_action",
      reason: "Customer seems satisfied with the solution",
      urgency: "none"
    };
  }

  if (conversationHistory.length >= 5) {
    return {
      action: "offer_ticket",
      reason: "Conversation has continued without clear resolution",
      urgency: "low"
    };
  }

  return {
    action: "no_action",
    reason: "Insufficient context to determine support need",
    urgency: "none"
  };
}

function extractCustomerInfo(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return { email: null, name: null, version: null, platform: null };
  }

  const emailPattern = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let email = null;
  let name = null;
  let version = null;
  let platform = null;

  for (const message of conversationHistory) {
    const content = message.content;
    
    if (!email) {
      const emailMatch = content.match(emailPattern);
      if (emailMatch) email = emailMatch[0];
    }

    if (!name && message.role === "user") {
      const nameMatch = content.match(/(?:i'?m|my name is|this is|call me|i'm called)\s+([A-Z][a-z]+)/i);
      if (nameMatch) name = nameMatch[1];
    }

    if (!version) {
      const versionMatch = content.match(/(?:version|v\.?)\s*(\d+(?:\.\d+)*)|(\d+\.\d+(?:\.\d+)?)/i);
      if (versionMatch) version = versionMatch[1] || versionMatch[2];
    }

    if (!platform) {
      if (/\bwindows\b/i.test(content)) {
        platform = "Windows";
      } else if (/\b(?:linux|ubuntu|debian|fedora)\b/i.test(content)) {
        platform = "Linux";
      } else if (/\b(?:mac|macos|osx)\b/i.test(content)) {
        platform = "macOS";
      }
    }

    if (email && name && version && platform) break;
  }

  return { email, name, version, platform };
}

async function evaluateConversationForSupport(conversationHistory) {
  const analysis = analyzeConversationForSupport(conversationHistory);
  const customerInfo = extractCustomerInfo(conversationHistory);

  const missingFields = [];
  if (!customerInfo.email) missingFields.push("email");
  if (!customerInfo.name) missingFields.push("name");
  if (!customerInfo.version) missingFields.push("product version");
  if (!customerInfo.platform) missingFields.push("platform (Windows/Linux/macOS)");

  return {
    analysis,
    customerInfo,
    requiresUserInput: missingFields.length > 0,
    missingFields: missingFields,
  };
}

async function sendEmail(input) {
  const content = input?.content ? String(input.content).trim() : "";
  const contactEmail = input?.contactEmail ? String(input.contactEmail).trim() : "";
  const contactName = input?.contactName ? String(input.contactName).trim() : "";
  const subject = input?.subject ? String(input.subject).trim() : "";
  const conversationHistory = input?.conversationHistory || [];
  const productName = input?.productName ? String(input.productName).trim() : "";
  const version = input?.version ? String(input.version).trim() : "";
  const platform = input?.platform ? String(input.platform).trim() : "";

  if (!content) throw new Error("Missing required field: content");
  if (!contactEmail) throw new Error("Missing required field: contactEmail");

  const hubspotBccEmail = process.env.HUBSPOT_BCC_EMAIL;
  if (!hubspotBccEmail) {
    throw new Error("HUBSPOT_BCC_EMAIL not configured (e.g., support@youraccount.hs-inbox.com)");
  }
  const hubspotInboxId = process.env.HUBSPOT_INBOX_ID;
  if (!hubspotInboxId) {
    throw new Error("HUBSPOT_INBOX_ID not configured");
  }
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    throw new Error("HUBSPOT_ACCESS_TOKEN not configured");
  }

  const hubspotContactId = null;

  const finalSubject = subject || content.split('\n')[0].substring(0, 60);

  let emailText = "";
  if (platform) emailText += `Platform: ${platform}\n\n`;

  const productInfo = productName ? `${productName}${version ? ' ' + version : ''}` : (version ? `version ${version}` : "the product");
  emailText += `Customer reported the following issue with ${productInfo}:\n\n`;
  
  const contentLines = content.split('\n');
  let inIssuesSection = false;
  let inSuggestionsSection = false;
  let issuesText = "";
  let suggestionsText = "";
  
  for (const line of contentLines) {
    if (/issues?:/i.test(line) || /problems?:/i.test(line) || /errors?:/i.test(line)) {
      inIssuesSection = true;
      inSuggestionsSection = false;
      continue;
    } else if (/suggestions?:/i.test(line) || /fixes?:/i.test(line) || /solutions?:/i.test(line) || /tried:/i.test(line)) {
      inIssuesSection = false;
      inSuggestionsSection = true;
      continue;
    }
    
    if (inIssuesSection && line.trim()) {
      issuesText += line + "\n";
    } else if (inSuggestionsSection && line.trim()) {
      suggestionsText += line + "\n";
    }
  }

  if (!issuesText && !suggestionsText) {
    issuesText = content;
  }

  emailText += issuesText || content;
  
  if (suggestionsText) {
    emailText += `\n\nI suggested the following fixes from the documentation:\n\n${suggestionsText}`;
  }

  if (conversationHistory && conversationHistory.length > 0) {
    emailText += "\n\n--- Conversation History ---\n";
    
    conversationHistory.forEach((msg) => {
      const role = msg.role === "user" ? "Customer" : "Assistant";
      const msgContent = msg.content || "";
      emailText += `\n[${role}]: ${msgContent}\n`;
    });
    emailText += "\n--- End Conversation ---";
  }

  let emailHtml = `<div style="font-family: Arial, sans-serif;">`;
  if (platform) emailHtml += `<p><strong>Platform:</strong> ${platform}</p>`;
  emailHtml += `<hr>`;
  emailHtml += `<h3>Customer reported the following issue with ${productInfo}:</h3>`;
  emailHtml += `<div style="margin: 15px 0;">${(issuesText || content).replace(/\n/g, "<br>")}</div>`;
  
  if (suggestionsText) {
    emailHtml += `<h3>I suggested the following fixes from the documentation:</h3>`;
    emailHtml += `<div style="margin: 15px 0;">${suggestionsText.replace(/\n/g, "<br>")}</div>`;
  }

  if (conversationHistory && conversationHistory.length > 0) {
    emailHtml += `<hr><h3>Conversation History</h3>`;
    conversationHistory.forEach((msg) => {
      const role = msg.role === "user" ? "Customer" : "Assistant";
      const msgContent = msg.content || "";
      emailHtml += `<div style="margin: 10px 0; padding: 10px; background: ${msg.role === 'user' ? '#f0f0f0' : '#e3f2fd'}; border-radius: 5px;"><strong>${role}:</strong><br>${msgContent.replace(/\n/g, "<br>")}</div>`;
    });
  }

  emailHtml += `<hr><p style="color: #666;"><em>Support ticket created with GitBook assistant</em></p></div>`;

  emailText += "\n\n---\nSupport ticket created with GitBook assistant";

  const emailSentAt = Date.now();
  const info = await transporter.sendMail({
    from: process.env.SMTP_USER,
    replyTo: contactEmail,
    to: contactEmail,
    bcc: hubspotBccEmail,
    subject: finalSubject,
    text: emailText,
    html: emailHtml,
  });

  const internalContactName = contactName || contactEmail;
  const internalCommentText =
    "This ticket was made using the GitBook AI, please press the cross next to the contact to disassociate, and associate with the following contact:\n" +
    `Name: ${internalContactName}\n` +
    `Email: ${contactEmail}`;
  const internalCommentHtml = `<div style="font-family: Arial, sans-serif;">
    <p>This ticket was made using the GitBook AI, please press the cross next to the contact to disassociate, and associate with the following contact:</p>
    <p><strong>Name:</strong> ${internalContactName}<br><strong>Email:</strong> ${contactEmail}</p>
  </div>`;

  const pollAttempts = Number(process.env.HUBSPOT_THREAD_POLL_ATTEMPTS || 5);
  const pollIntervalMs = Number(process.env.HUBSPOT_THREAD_POLL_INTERVAL_MS || 3000);
  const lookbackMs = Number(process.env.HUBSPOT_THREAD_LOOKBACK_MS || 10 * 60 * 1000);
  const latestMessageTimestampAfter = emailSentAt - lookbackMs;

  let threadId = null;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    threadId = await findThreadIdByInbox({
      inboxId: hubspotInboxId,
      latestMessageTimestampAfter,
      subject: finalSubject,
    });

    if (threadId) break;
    if (attempt < pollAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  if (!threadId) {
    throw new Error("Unable to locate HubSpot thread for internal comment");
  }

  await postInternalComment({
    threadId,
    text: internalCommentText,
    richText: internalCommentHtml,
  });



  return {
    success: true,
    messageId: info.messageId,
    hubspotContactId: hubspotContactId,
    forwardedTo: hubspotBccEmail,
    hubspotThreadId: threadId,
  };
}

// ---------- MCP server ----------
const server = new Server(
  {
    name: "email-forwarding-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "evaluate_support_need",
        description:
          "Analyzes conversation history to determine if a support ticket should be offered or created. Detects if customer is unsatisfied, explicitly requesting support, or satisfied with the solution.",
        inputSchema: {
          type: "object",
          properties: {
            conversationHistory: {
              type: "array",
              description: "Array of conversation messages with 'role' (user/assistant) and 'content' (message text)",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" }
                },
                required: ["role", "content"]
              }
            }
          },
          required: ["conversationHistory"],
          additionalProperties: false,
        },
      },
      {
        name: "send_customer_email",
        description:
          "Sends a customer support email to the customer while BCC'ing the HubSpot Conversations inbox for ticket creation.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The message content to send.",
            },
            contactEmail: {
              type: "string",
              description: "Customer email address (required). Will be used as the sender so HubSpot associates correctly to the customer contact.",
            },
            contactName: { 
              type: "string", 
              description: "Customer name (optional). Used in email body." 
            },
            subject: {
              type: "string",
              description: "Email subject line (optional). If not provided, will use first line of message content."
            },
            conversationHistory: {
              type: "array",
              description: "Full conversation history (optional). Array of message objects with 'role' and 'content' fields. Will be formatted and included in the email.",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  content: { type: "string" }
                }
              }
            },
            productName: {
              type: "string",
              description: "Name of the product (e.g., 'MailScheduler', 'Writeback Extreme'). Used in email header and HubSpot contact property."
            },
            version: {
              type: "string",
              description: "Product version number (e.g., '1.2.3', '2.0'). Used in email header and HubSpot contact property."
            },
            platform: {
              type: "string",
              description: "Operating system platform (e.g., 'Windows', 'Linux', 'macOS'). Displayed in email metadata and HubSpot contact property."
            },
          },
          required: ["content", "contactEmail"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  try {
    let result;

    if (toolName === "evaluate_support_need") {
      result = await evaluateConversationForSupport(args.conversationHistory);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } else if (toolName === "send_customer_email") {
      result = await sendEmail(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: "Your support request has been sent to the Apps for Tableau support team. We will get back to you ASAP!",
                messageId: result.messageId,
                hubspotContactId: result.hubspotContactId,
                forwardedTo: result.forwardedTo,
                hubspotThreadId: result.hubspotThreadId,
              },
              null,
              2
            ),
          },
        ],
      };
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HubSpot MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
