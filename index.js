import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBSPOT_API_URL = "https://api.hubapi.com";
const PORT = process.env.PORT || 3000;

async function createHubSpotTicket(data) {
  if (!HUBSPOT_API_KEY) {
    throw new Error("HUBSPOT_API_KEY environment variable is not set");
  }

  let contactId;
  if (data.contactEmail) {
    contactId = await findOrCreateContact(data.contactEmail, data.contactName);
  }

  const ticketProperties = {
    subject: data.subject,
    content: data.content,
    hs_pipeline: "0",
    hs_pipeline_stage: "1",
  };

  if (data.priority) {
    ticketProperties.hs_ticket_priority = data.priority;
  }

  if (data.category) {
    ticketProperties.hs_ticket_category = data.category;
  }

  const ticketPayload = {
    properties: ticketProperties,
  };

  if (contactId) {
    ticketPayload.associations = [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 16,
          },
        ],
      },
    ];
  }

  const response = await fetch(`${HUBSPOT_API_URL}/crm/v3/objects/tickets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ticketPayload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HubSpot API error: ${response.status} - ${error}`);
  }

  return await response.json();
}

async function findOrCreateContact(email, name) {
  const searchResponse = await fetch(
    `${HUBSPOT_API_URL}/crm/v3/objects/contacts/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      }),
    }
  );

  const searchData = await searchResponse.json();

  if (searchData.results && searchData.results.length > 0) {
    return searchData.results[0].id;
  }

  const properties = { email };

  if (name) {
    const nameParts = name.split(" ");
    properties.firstname = nameParts[0];
    if (nameParts.length > 1) {
      properties.lastname = nameParts.slice(1).join(" ");
    }
  }

  const createResponse = await fetch(
    `${HUBSPOT_API_URL}/crm/v3/objects/contacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    }
  );

  const contactData = await createResponse.json();
  return contactData.id;
}

// Create MCP server
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
          "Creates a support ticket in HubSpot with customer context. Use this when a customer needs help or reports an issue.",
        inputSchema: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "The ticket subject/title",
            },
            content: {
              type: "string",
              description:
                "The detailed ticket content/description including all customer context",
            },
            priority: {
              type: "string",
              enum: ["LOW", "MEDIUM", "HIGH"],
              description: "Ticket priority level",
            },
            category: {
              type: "string",
              description:
                "Ticket category (e.g., Technical Support, Billing, Feature Request)",
            },
            contactEmail: {
              type: "string",
              description: "Customer email to associate with ticket",
            },
            contactName: {
              type: "string",
              description: "Customer name",
            },
          },
          required: ["subject", "content"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "create_hubspot_ticket") {
    const args = request.params.arguments;

    try {
      const result = await createHubSpotTicket(args);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                ticketId: result.id,
                ticketUrl: `https://app.hubspot.com/contacts/${result.properties.hs_object_id}`,
                message: "Support ticket created successfully in HubSpot",
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
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Create Express app for HTTP transport
const app = express();

app.get("/health", (req, res) => {
  res.json({ status: "healthy", service: "hubspot-mcp-server" });
});

app.get("/sse", async (req, res) => {
  console.log("New SSE connection established");

  const transport = new SSEServerTransport("/message", res);
  await server.connect(transport);

  req.on("close", () => {
    console.log("SSE connection closed");
  });
});

app.post("/message", async (req, res) => {
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`HubSpot MCP Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/sse`);
});
