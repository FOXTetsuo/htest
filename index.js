/**
 * Email MCP Server
 * 
 * Simple server that sends customer messages as emails via SMTP.
 * Forwards messages to pownur@gmail.com.
 * 
 * Required env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   EMAIL_FROM (optional, defaults to noreply@appsfortableau.com)
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import nodemailer from "nodemailer";

// Setup email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ---------- Conversation analysis ----------
function analyzeConversationForSupport(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return { action: "no_action", reason: "No conversation history provided" };
  }

  const lastMessages = conversationHistory.slice(-4).map(m => m.content.toLowerCase());
  
  // Check if customer explicitly asked for support
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

  // Check if customer said the answer didn't help (negative response)
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

  // Check for signs of confusion, errors, or unresolved issues
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

  // Check if customer seems unsure after explanation
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

  // Check if customer said yes or seems satisfied
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

  // Default: offer ticket if conversation has gone back and forth
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

  // Look for email pattern in conversation
  const emailPattern = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let email = null;
  let name = null;
  let version = null;
  let platform = null;

  for (const message of conversationHistory) {
    const content = message.content;
    
    // Extract email
    if (!email) {
      const emailMatch = content.match(emailPattern);
      if (emailMatch) email = emailMatch[0];
    }

    // Extract name (first message from customer often contains it)
    if (!name && message.role === "user") {
      // Try common patterns like "I'm [name]" or "My name is [name]"
      const nameMatch = content.match(/(?:i'?m|my name is|this is|call me|i'm called)\s+([A-Z][a-z]+)/i);
      if (nameMatch) name = nameMatch[1];
    }

    // Extract version
    if (!version) {
      // Match version patterns like "1.2.3", "v1.2", "version 1.2", etc.
      const versionMatch = content.match(/(?:version|v\.?)\s*(\d+(?:\.\d+)*)|(\d+\.\d+(?:\.\d+)?)/i);
      if (versionMatch) version = versionMatch[1] || versionMatch[2];
    }

    // Extract platform
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

// ---------- Main logic ----------
async function evaluateConversationForSupport(conversationHistory) {
  const analysis = analyzeConversationForSupport(conversationHistory);
  const customerInfo = extractCustomerInfo(conversationHistory);

  // Determine which fields are missing
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

  // Generate subject if not provided
  const finalSubject = subject || content.split('\n')[0].substring(0, 60);

  // Build structured email body
  let emailText = `Customer: ${contactName || contactEmail}\n`;
  emailText += `Email: ${contactEmail}\n`;
  if (platform) emailText += `Platform: ${platform}\n`;
  emailText += `\n`;

  // Product header
  const productInfo = productName ? `${productName}${version ? ' ' + version : ''}` : (version ? `version ${version}` : "the product");
  emailText += `Customer reported the following issue with ${productInfo}:\n\n`;
  
  // Parse content to extract issues and suggestions
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

  // If no structured format found, use entire content as issue
  if (!issuesText && !suggestionsText) {
    issuesText = content;
  }

  emailText += issuesText || content;
  
  if (suggestionsText) {
    emailText += `\n\nI suggested the following fixes from the documentation:\n\n${suggestionsText}`;
  }

  // Format conversation history
  if (conversationHistory && conversationHistory.length > 0) {
    emailText += "\n\n--- Conversation History ---\n";
    
    conversationHistory.forEach((msg) => {
      const role = msg.role === "user" ? "Customer" : "Assistant";
      const msgContent = msg.content || "";
      emailText += `\n[${role}]: ${msgContent}\n`;
    });
    emailText += "\n--- End Conversation ---";
  }

  // HTML version
  let emailHtml = `<div style="font-family: Arial, sans-serif;">`;
  emailHtml += `<p><strong>Customer:</strong> ${contactName || contactEmail}</p>`;
  emailHtml += `<p><strong>Email:</strong> ${contactEmail}</p>`;
  if (platform) emailHtml += `<p><strong>Platform:</strong> ${platform}</p>`;
  emailHtml += `<hr>`;
  emailHtml += `<h3>Customer reported the following issue with ${productInfo}:</h3>`;
  emailHtml += `<div style="margin: 15px 0;">${(issuesText || content).replace(/\n/g, "<br>")}</div>`;
  
  if (suggestionsText) {
    emailHtml += `<h3>I suggested the following fixes from the documentation:</h3>`;
    emailHtml += `<div style="margin: 15px 0;">${suggestionsText.replace(/\n/g, "<br>")}</div>`;
  }

  // Add conversation history to HTML
  if (conversationHistory && conversationHistory.length > 0) {
    emailHtml += `<hr><h3>Conversation History</h3>`;
    conversationHistory.forEach((msg) => {
      const role = msg.role === "user" ? "Customer" : "Assistant";
      const msgContent = msg.content || "";
      emailHtml += `<div style="margin: 10px 0; padding: 10px; background: ${msg.role === 'user' ? '#f0f0f0' : '#e3f2fd'}; border-radius: 5px;"><strong>${role}:</strong><br>${msgContent.replace(/\n/g, "<br>")}</div>`;
    });
  }

  emailHtml += `<hr><p style="color: #666;"><em>Support ticket created with GitBook assistant</em></p></div>`;

  // Add footer to text version
  emailText += "\n\n---\nSupport ticket created with GitBook assistant";

  // Send email
  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || "noreply@appsfortableau.com",
    to: "support@appsfortableau.infotopics.com",
    subject: finalSubject,
    text: emailText,
    html: emailHtml,
    replyTo: contactEmail,
  });

  return {
    success: true,
    messageId: info.messageId,
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
          "Sends a customer message as a support ticket email to pownur@gmail.com. The customer's email is set as the reply-to address. Includes footer 'Support ticket created with gitBook assistant'.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The message content to send.",
            },
            contactEmail: {
              type: "string",
              description: "Customer email address (required). Will be used as reply-to address.",
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
              description: "Name of the product (e.g., 'MailScheduler', 'Writeback Extreme'). Used in email header."
            },
            version: {
              type: "string",
              description: "Product version number (e.g., '1.2.3', '2.0'). Used in email header."
            },
            platform: {
              type: "string",
              description: "Operating system platform (e.g., 'Windows', 'Linux', 'macOS'). Displayed in email metadata."
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
                message: "Email sent to pownur@gmail.com",
                messageId: result.messageId,
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

// Use stdio transport for Claude Code / Claude Desktop
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HubSpot MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});