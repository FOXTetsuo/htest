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

// ---------- Main logic ----------
async function sendEmail(input) {
  const content = input?.content ? String(input.content).trim() : "";
  const contactEmail = input?.contactEmail ? String(input.contactEmail).trim() : "";
  const contactName = input?.contactName ? String(input.contactName).trim() : "";
  const subject = input?.subject ? String(input.subject).trim() : "";

  if (!content) throw new Error("Missing required field: content");
  if (!contactEmail) throw new Error("Missing required field: contactEmail");

  // Generate subject if not provided
  const finalSubject = subject || content.split('\n')[0].substring(0, 60);

  // Add footer to content
  const footer = "\n\n---\nSupport ticket created with gitBook assistant";
  const emailContent = content + footer;
  const emailHtml = `<p><strong>From:</strong> ${contactName || contactEmail}</p><p><strong>Email:</strong> ${contactEmail}</p><p><strong>Message:</strong></p><p>${content.replace(/\n/g, "<br>")}</p><hr><p><em>Support ticket created with gitBook assistant</em></p>`;

  // Send email
  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || "noreply@appsfortableau.com",
    to: "pownur@gmail.com",
    subject: finalSubject,
    text: emailContent,
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
          },
          required: ["content", "contactEmail"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "send_customer_email") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    const args = request.params.arguments ?? {};
    const result = await sendEmail(args);

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