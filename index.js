/**
 * HubSpot MCP Server (Tickets)
 * Auth: Private App / Access Token (Bearer)
 *
 * Required env var:
 *   HUBSPOT_ACCESS_TOKEN=pat-...
 *
 * Notes:
 * - Fixes `fetch is not defined` by using undici.
 * - Uses Bearer token correctly for HubSpot API calls.
 * - Improves error handling + validates required inputs.
 * - Creates/looks up a Contact by email and associates it to the Ticket.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetch } from "undici"; // ✅ ensures fetch exists across Node runtimes

const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HUBSPOT_API_URL = "https://api.hubapi.com";

// ---------- Helpers ----------
function assertEnv() {
  if (!HUBSPOT_ACCESS_TOKEN) {
    throw new Error("HUBSPOT_ACCESS_TOKEN environment variable is not set");
  }
}

function hubspotHeaders() {
  assertEnv();
  return {
    Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function hubspotRequest(path, { method = "GET", body } = {}) {
  const url = `${HUBSPOT_API_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: hubspotHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    // HubSpot often returns JSON error bodies; keep it readable either way.
    throw new Error(
      `HubSpot API error: ${res.status} ${res.statusText} - ${text || "(empty response)"}`
    );
  }

  // Some endpoints can return empty bodies; be defensive.
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizePriority(priority) {
  if (!priority) return undefined;
  const p = String(priority).toUpperCase();
  if (!["LOW", "MEDIUM", "HIGH"].includes(p)) {
    throw new Error(`Invalid priority '${priority}'. Use LOW, MEDIUM, or HIGH.`);
  }
  return p;
}

// ---------- HubSpot logic ----------
async function findContactByEmail(email) {
  const searchPayload = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "email",
            operator: "EQ",
            value: email,
          },
        ],
      },
    ],
    limit: 1,
    properties: ["email", "firstname", "lastname"],
  };

  const data = await hubspotRequest("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: searchPayload,
  });

  const result = data?.results?.[0];
  return result?.id || null;
}

async function createContact(email, name) {
  const properties = { email };

  if (name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) properties.firstname = parts[0];
    if (parts.length > 1) properties.lastname = parts.slice(1).join(" ");
  }

  const data = await hubspotRequest("/crm/v3/objects/contacts", {
    method: "POST",
    body: { properties },
  });

  if (!data?.id) throw new Error("Contact created but no id returned by HubSpot.");
  return data.id;
}

async function findOrCreateContact(email, name) {
  if (!email) return null;
  const existingId = await findContactByEmail(email);
  if (existingId) return existingId;
  return await createContact(email, name);
}

async function createHubSpotTicket(input) {
  const subject = input?.subject ? String(input.subject).trim() : "";
  const content = input?.content ? String(input.content).trim() : "";

  if (!subject) throw new Error("Missing required field: subject");
  if (!content) throw new Error("Missing required field: content");

  const contactEmail = input?.contactEmail ? String(input.contactEmail).trim() : "";
  const contactName = input?.contactName ? String(input.contactName).trim() : "";
  const category = input?.category ? String(input.category).trim() : "";
  const priority = normalizePriority(input?.priority);

  let contactId = null;
  if (contactEmail) {
    contactId = await findOrCreateContact(contactEmail, contactName);
  }

  const ticketProperties = {
    subject,
    content,
    hs_pipeline: "0",
    hs_pipeline_stage: "1",
    ...(priority ? { hs_ticket_priority: priority } : {}),
    ...(category ? { hs_ticket_category: category } : {}),
  };

  const ticketPayload = {
    properties: ticketProperties,
    ...(contactId
      ? {
          associations: [
            {
              to: { id: contactId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: 16, // Ticket -> Contact
                },
              ],
            },
          ],
        }
      : {}),
  };

  const ticket = await hubspotRequest("/crm/v3/objects/tickets", {
    method: "POST",
    body: ticketPayload,
  });

  if (!ticket?.id) throw new Error("Ticket created but no id returned by HubSpot.");
  return ticket;
}

// ---------- MCP server ----------
const server = new Server(
  {
    name: "hubspot-ticket-server",
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
        name: "create_hubspot_ticket",
        description:
          "Creates a support ticket in HubSpot with optional contact association (by email).",
        inputSchema: {
          type: "object",
          properties: {
            subject: { type: "string", description: "The ticket subject/title" },
            content: {
              type: "string",
              description: "The detailed ticket content/description including all customer context",
            },
            priority: {
              type: "string",
              enum: ["LOW", "MEDIUM", "HIGH"],
              description: "Ticket priority level",
            },
            category: {
              type: "string",
              description: "Ticket category (e.g., Technical Support, Billing, Feature Request)",
            },
            contactEmail: {
              type: "string",
              description: "Customer email to associate with ticket",
            },
            contactName: { type: "string", description: "Customer name" },
          },
          required: ["subject", "content"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "create_hubspot_ticket") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    const args = request.params.arguments ?? {};
    const ticket = await createHubSpotTicket(args);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              ticketId: ticket.id,
              // HubSpot "app" URLs depend on portal/account id; return id only.
              message: "Support ticket created successfully in HubSpot",
              ticket: ticket, // keep full response for debugging/use
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