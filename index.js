/**
 * HubSpot Forms MCP Server
 *
 * Submits form data to HubSpot Forms API (legacy v3 endpoint).
 * Includes a preconfigured tool for the support form in portal 25291663.
 *
 * Required env vars (unless provided in tool input):
 *   HUBSPOT_PORTAL_ID, HUBSPOT_FORM_GUID
 * Optional env vars:
 *   HUBSPOT_FORMS_BASE_URL (e.g., https://api.hsforms.com or https://api-eu1.hsforms.com)
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SUPPORT_FORM_TICKET_CATEGORY_VALUES = [
  "PRODUCT_ISSUE",
  "BILLING_ISSUE",
  "FEATURE_REQUEST",
  "GENERAL_INQUIRY",
];

const SUPPORT_FORM_TICKET_CATEGORY_ALIASES = {
  "Product issue": "PRODUCT_ISSUE",
  "Billing issue": "BILLING_ISSUE",
  "Feature request": "FEATURE_REQUEST",
  "General inquiry": "GENERAL_INQUIRY",
};

const SUPPORT_FORM_TICKET_CATEGORY_INPUTS = [
  ...SUPPORT_FORM_TICKET_CATEGORY_VALUES,
  ...Object.keys(SUPPORT_FORM_TICKET_CATEGORY_ALIASES),
];

const SUPPORT_FORM_TICKET_EXTENSION_VALUES = [
  "DashboardGuide",
  "DashboardUsage",
  "DreamTeams",
  "DrillDownTree",
  "EasyDesigns",
  "ExtensionsManager",
  "hierarchy-filter",
  "MailScheduler",
  "PerformanceInsight",
  "PictureThis",
  "ProcessMining",
  "ScrollyTelling",
  "ShowMeMore",
  "SuperKPIs",
  "SuperTables",
  "viz-slides",
  "WriteBackExtreme",
  "No specific extension",
];

const SUPPORT_FORM_TICKET_EXTENSION_ALIASES = {
  PowerKPIs: "SuperKPIs",
  HierarchyFilter: "hierarchy-filter",
  VizSlides: "viz-slides",
};

const SUPPORT_FORM_TICKET_EXTENSION_INPUTS = [
  ...SUPPORT_FORM_TICKET_EXTENSION_VALUES,
  ...Object.keys(SUPPORT_FORM_TICKET_EXTENSION_ALIASES),
];

const SUPPORT_FORM = {
  portalId: "25291663",
  formGuid: "dc44a5b5-9577-4633-97fb-3410c599168e",
  defaultBaseUrl: "https://api-eu1.hsforms.com",
  fieldNames: {
    firstName: "firstname",
    lastName: "lastname",
    email: "email",
    company: "company",
    category: "TICKET.hs_ticket_category",
    subject: "TICKET.subject",
    content: "TICKET.content",
    ticketExtension: "TICKET.ticket_extension",
    extensionVersion: "TICKET.extension_version",
    fileUpload: "TICKET.hs_file_upload",
  },
  subscriptionTypeIds: {
    confirmationEmails: 130256869,
    serviceSupport: 125387774,
    productUpdates: 130256504,
  },
  consentTexts: {
    confirmationEmails: "I agree to receive confirmation emails about my requests",
    serviceSupport: "I agree to receive service/sales support",
    productUpdates: "Subscribe for product updates and exclusive content",
  },
  consentToProcessText:
    "I agree to allow Apps for Tableau to store and process my personal data.",
};

function analyzeConversationForSupport(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return { action: "no_action", reason: "No conversation history provided" };
  }

  const lastMessages = conversationHistory.slice(-4).map((m) => m.content.toLowerCase());

  const explicitSupportRequest = lastMessages.some((msg) =>
    /support|agent|speak with|contact|help team|representative|specialist|support ticket/.test(msg)
  );

  if (explicitSupportRequest) {
    return {
      action: "offer_or_create_ticket",
      reason: "Customer explicitly requested support",
      urgency: "high",
    };
  }

  const negativeResponse = lastMessages.some(
    (msg) =>
      /^(no|didn't help|doesn't work|still broken|still doesn't|nope|nah|didn't solve|doesn't solve)/.test(msg) ||
      /didn't (help|work|solve)|doesn't (help|work|solve)|not (helpful|working)|still (broken|failing|doesn't)/.test(msg)
  );

  if (negativeResponse) {
    return {
      action: "offer_or_create_ticket",
      reason: "Customer indicated suggested solution did not help",
      urgency: "high",
    };
  }

  const confusionOrError = lastMessages.some((msg) =>
    /error|failed|broken|stuck|confused|not sure|unclear|doesn't show|missing|not (working|appearing)|crash|freeze|hang/.test(
      msg
    )
  );

  if (confusionOrError && conversationHistory.length >= 3) {
    return {
      action: "offer_ticket",
      reason: "Customer appears to be experiencing technical issues",
      urgency: "medium",
    };
  }

  const uncertainResponse = lastMessages.some((msg) =>
    /\?$|what if|what about|how do i|can't figure|not clear|still don't|what do you mean|don't understand|what's|how's/.test(
      msg
    )
  );

  if (uncertainResponse && conversationHistory.length >= 4) {
    return {
      action: "offer_ticket",
      reason: "Customer appears uncertain and may need direct assistance",
      urgency: "medium",
    };
  }

  const positiveResponse = lastMessages.some(
    (msg) =>
      /^(yes|yep|yeah|yup|thanks|that works|solved|fixed|great|perfect|ok|good)/.test(msg) ||
      /works|solved|fixed|helpful|thanks/.test(msg)
  );

  if (positiveResponse) {
    return {
      action: "no_action",
      reason: "Customer seems satisfied with the solution",
      urgency: "none",
    };
  }

  if (conversationHistory.length >= 5) {
    return {
      action: "offer_ticket",
      reason: "Conversation has continued without clear resolution",
      urgency: "low",
    };
  }

  return {
    action: "no_action",
    reason: "Insufficient context to determine support need",
    urgency: "none",
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

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function requireValue(value, fieldLabel) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`Missing required field: ${fieldLabel}`);
  }
  return normalized;
}

function requireEnum(value, allowed, fieldLabel, aliases = {}) {
  const normalized = requireValue(value, fieldLabel);
  const mapped = aliases[normalized] || normalized;
  if (!allowed.includes(mapped)) {
    const options = [...allowed, ...Object.keys(aliases)];
    throw new Error(`Invalid ${fieldLabel}. Expected one of: ${options.join(", ")}`);
  }
  return mapped;
}

function requireTrue(value, fieldLabel) {
  if (value !== true) {
    throw new Error(`Missing required consent: ${fieldLabel}`);
  }
}

function normalizeFileUrls(fileUrlsInput) {
  if (!fileUrlsInput) return null;
  const urls = Array.isArray(fileUrlsInput) ? fileUrlsInput : [fileUrlsInput];
  const normalized = urls.map((url) => normalizeString(url)).filter(Boolean);
  if (normalized.length === 0) return null;
  return normalized.join(";");
}

function buildSupportTicketFields(input) {
  const fields = [
    {
      name: SUPPORT_FORM.fieldNames.firstName,
      value: requireValue(input?.firstName, "firstName"),
    },
    {
      name: SUPPORT_FORM.fieldNames.lastName,
      value: requireValue(input?.lastName, "lastName"),
    },
    {
      name: SUPPORT_FORM.fieldNames.email,
      value: requireValue(input?.email, "email"),
    },
    {
      name: SUPPORT_FORM.fieldNames.category,
      value: requireEnum(
        input?.ticketCategory,
        SUPPORT_FORM_TICKET_CATEGORY_VALUES,
        "ticketCategory",
        SUPPORT_FORM_TICKET_CATEGORY_ALIASES
      ),
    },
    {
      name: SUPPORT_FORM.fieldNames.subject,
      value: requireValue(input?.ticketName, "ticketName"),
    },
    {
      name: SUPPORT_FORM.fieldNames.content,
      value: requireValue(input?.ticketDescription, "ticketDescription"),
    },
    {
      name: SUPPORT_FORM.fieldNames.ticketExtension,
      value: requireEnum(
        input?.ticketExtension,
        SUPPORT_FORM_TICKET_EXTENSION_VALUES,
        "ticketExtension",
        SUPPORT_FORM_TICKET_EXTENSION_ALIASES
      ),
    },
    {
      name: SUPPORT_FORM.fieldNames.extensionVersion,
      value: requireValue(input?.extensionVersion, "extensionVersion"),
    },
  ];

  const company = normalizeString(input?.company);
  if (company) {
    fields.push({ name: SUPPORT_FORM.fieldNames.company, value: company });
  }

  const fileUrls = normalizeFileUrls(input?.fileUrls ?? input?.fileUrl);
  if (fileUrls) {
    fields.push({ name: SUPPORT_FORM.fieldNames.fileUpload, value: fileUrls });
  }

  return fields;
}

function buildSupportTicketConsent(input) {
  requireTrue(input?.consentConfirmationEmails, "consentConfirmationEmails");
  requireTrue(input?.consentServiceSupport, "consentServiceSupport");

  const consentTexts = input?.consentTexts ?? {};
  let consentToProcess = true;
  if (typeof input?.consentToProcess === "boolean") {
    requireTrue(input.consentToProcess, "consentToProcess");
    consentToProcess = input.consentToProcess;
  }
  const consentToProcessText =
    normalizeString(input?.consentToProcessText) || SUPPORT_FORM.consentToProcessText;

  const communications = [
    {
      value: true,
      subscriptionTypeId: SUPPORT_FORM.subscriptionTypeIds.confirmationEmails,
      text: consentTexts.confirmationEmails || SUPPORT_FORM.consentTexts.confirmationEmails,
    },
    {
      value: true,
      subscriptionTypeId: SUPPORT_FORM.subscriptionTypeIds.serviceSupport,
      text: consentTexts.serviceSupport || SUPPORT_FORM.consentTexts.serviceSupport,
    },
  ];

  if (typeof input?.consentProductUpdates === "boolean") {
    communications.push({
      value: input.consentProductUpdates,
      subscriptionTypeId: SUPPORT_FORM.subscriptionTypeIds.productUpdates,
      text: consentTexts.productUpdates || SUPPORT_FORM.consentTexts.productUpdates,
    });
  }

  return {
    consent: {
      consentToProcess,
      text: consentToProcessText,
      communications,
    },
  };
}

function buildSupportTicketContext(input) {
  if (input?.context && typeof input.context === "object") {
    return input.context;
  }

  const context = {};
  const hutk = normalizeString(input?.hutk);
  const pageUri = normalizeString(input?.pageUri);
  const pageName = normalizeString(input?.pageName);
  const ipAddress = normalizeString(input?.ipAddress);

  if (hutk) context.hutk = hutk;
  if (pageUri) context.pageUri = pageUri;
  if (pageName) context.pageName = pageName;
  if (ipAddress) context.ipAddress = ipAddress;

  return Object.keys(context).length > 0 ? context : null;
}

function normalizeFields(fieldsInput) {
  if (!Array.isArray(fieldsInput) || fieldsInput.length === 0) {
    throw new Error("Missing required field: fields");
  }

  return fieldsInput.map((field, index) => {
    if (!field || typeof field !== "object") {
      throw new Error(`Invalid field at index ${index}`);
    }

    const name = typeof field.name === "string" ? field.name.trim() : "";
    if (!name) {
      throw new Error(`Missing field name at index ${index}`);
    }

    if (!("value" in field)) {
      throw new Error(`Missing field value for ${name}`);
    }

    const value = field.value;
    if (value === null || value === undefined) {
      throw new Error(`Missing field value for ${name}`);
    }

    return { name, value: String(value) };
  });
}

function buildFormSubmitUrl(baseUrl, portalId, formGuid) {
  const trimmedBaseUrl = baseUrl.replace(/\/$/, "");
  return `${trimmedBaseUrl}/submissions/v3/integration/submit/${portalId}/${formGuid}`;
}

function buildFormUploadUrl(baseUrl, portalId, formGuid) {
  const trimmedBaseUrl = baseUrl.replace(/\/$/, "");
  return `${trimmedBaseUrl}/uploads/form/v2/${portalId}/${formGuid}`;
}

async function submitHubspotForm(input) {
  const portalId = input?.portalId || process.env.HUBSPOT_PORTAL_ID;
  const formGuid = input?.formGuid || process.env.HUBSPOT_FORM_GUID;
  const baseUrl = String(
    input?.baseUrl || process.env.HUBSPOT_FORMS_BASE_URL || "https://api.hsforms.com"
  );

  if (!portalId) {
    throw new Error("Missing required field: portalId (or HUBSPOT_PORTAL_ID)");
  }

  if (!formGuid) {
    throw new Error("Missing required field: formGuid (or HUBSPOT_FORM_GUID)");
  }

  const fields = normalizeFields(input?.fields);

  const payload = { fields };
  if (input?.context && typeof input.context === "object") {
    payload.context = input.context;
  }
  if (input?.legalConsentOptions && typeof input.legalConsentOptions === "object") {
    payload.legalConsentOptions = input.legalConsentOptions;
  }
  if (input?.submittedAt !== undefined) {
    payload.submittedAt = input.submittedAt;
  }

  const response = await fetch(buildFormSubmitUrl(baseUrl, portalId, formGuid), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody = responseText;
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  }

  if (!response.ok) {
    const errorDetail =
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    throw new Error(`HubSpot form submission error ${response.status}: ${errorDetail}`);
  }

  return {
    success: true,
    response: responseBody || null,
  };
}

async function submitSupportTicketForm(input) {
  const portalId = input?.portalId || SUPPORT_FORM.portalId;
  const formGuid = input?.formGuid || SUPPORT_FORM.formGuid;
  const baseUrl = String(
    input?.baseUrl || process.env.HUBSPOT_FORMS_BASE_URL || SUPPORT_FORM.defaultBaseUrl
  );

  const fields = buildSupportTicketFields(input);
  const legalConsentOptions = buildSupportTicketConsent(input);
  const context = buildSupportTicketContext(input);

  const payload = {
    portalId,
    formGuid,
    baseUrl,
    fields,
    legalConsentOptions,
  };

  if (context) {
    payload.context = context;
  }

  if (input?.submittedAt !== undefined) {
    payload.submittedAt = input.submittedAt;
  }

  return submitHubspotForm(payload);
}

async function uploadHubspotFormFile(input) {
  const portalId =
    input?.portalId || process.env.HUBSPOT_PORTAL_ID || SUPPORT_FORM.portalId;
  const formGuid =
    input?.formGuid || process.env.HUBSPOT_FORM_GUID || SUPPORT_FORM.formGuid;
  const baseUrl = String(
    input?.baseUrl || process.env.HUBSPOT_FORMS_BASE_URL || SUPPORT_FORM.defaultBaseUrl
  );

  if (!portalId) {
    throw new Error("Missing required field: portalId (or HUBSPOT_PORTAL_ID)");
  }

  if (!formGuid) {
    throw new Error("Missing required field: formGuid (or HUBSPOT_FORM_GUID)");
  }

  const filePath = normalizeString(input?.filePath);
  if (!filePath) {
    throw new Error("Missing required field: filePath");
  }

  const fileName = normalizeString(input?.fileName) || basename(filePath);
  const fileBuffer = await readFile(filePath);

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);

  const response = await fetch(buildFormUploadUrl(baseUrl, portalId, formGuid), {
    method: "POST",
    body: formData,
  });

  const responseText = await response.text();
  let responseBody = responseText;
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  }

  if (!response.ok) {
    const errorDetail =
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    throw new Error(`HubSpot file upload error ${response.status}: ${errorDetail}`);
  }

  const fileUrl =
    responseBody && typeof responseBody === "object"
      ? responseBody.url || responseBody.fileUrl || responseBody.filePath || null
      : null;

  return {
    success: true,
    fileUrl,
    response: responseBody || null,
  };
}

// ---------- MCP server ----------
const server = new Server(
  {
    name: "hubspot-forms-server",
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
              description:
                "Array of conversation messages with 'role' (user/assistant) and 'content' (message text)",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
          },
          required: ["conversationHistory"],
          additionalProperties: false,
        },
      },
      {
        name: "submit_support_ticket_form",
        description:
          "Submits the Apps for Tableau support ticket form to HubSpot (preconfigured portal/form IDs).",
        inputSchema: {
          type: "object",
          properties: {
            portalId: {
              type: "string",
              description:
                "Override portal ID (defaults to 25291663).",
            },
            formGuid: {
              type: "string",
              description:
                "Override form GUID (defaults to dc44a5b5-9577-4633-97fb-3410c599168e).",
            },
            baseUrl: {
              type: "string",
              description:
                "Override the HubSpot Forms base URL (e.g., https://api-eu1.hsforms.com).",
            },
            firstName: {
              type: "string",
              description: "First name (firstname).",
            },
            lastName: {
              type: "string",
              description: "Last name (lastname).",
            },
            email: {
              type: "string",
              description: "Email address (email).",
            },
            company: {
              type: "string",
              description: "Company name (company).",
            },
            ticketCategory: {
              type: "string",
              description: "Ticket category (TICKET.hs_ticket_category).",
              enum: SUPPORT_FORM_TICKET_CATEGORY_INPUTS,
            },
            ticketName: {
              type: "string",
              description: "Ticket name (TICKET.subject).",
            },
            ticketDescription: {
              type: "string",
              description: "Ticket description (TICKET.content).",
            },
            ticketExtension: {
              type: "string",
              description: "Ticket product type (TICKET.ticket_extension).",
              enum: SUPPORT_FORM_TICKET_EXTENSION_INPUTS,
            },
            extensionVersion: {
              type: "string",
              description: "Extension version (TICKET.extension_version).",
            },
            fileUrls: {
              type: "array",
              description:
                "Optional file URLs (from HubSpot form upload) for TICKET.hs_file_upload.",
              items: { type: "string" },
            },
            fileUrl: {
              type: "string",
              description:
                "Optional single file URL for TICKET.hs_file_upload.",
            },
            consentConfirmationEmails: {
              type: "boolean",
              description:
                "Required. Consent for confirmation emails (subscription type 130256869). Must be true.",
            },
            consentServiceSupport: {
              type: "boolean",
              description:
                "Required. Consent for service/sales support (subscription type 125387774). Must be true.",
            },
            consentProductUpdates: {
              type: "boolean",
              description:
                "Optional. Consent for product updates (subscription type 130256504).",
            },
            consentToProcess: {
              type: "boolean",
              description:
                "Optional. Consent to process personal data. Must be true if provided.",
            },
            consentToProcessText: {
              type: "string",
              description:
                "Optional. Consent-to-process text shown with GDPR consent.",
            },
            consentTexts: {
              type: "object",
              description: "Optional override text for consent checkboxes.",
              properties: {
                confirmationEmails: { type: "string" },
                serviceSupport: { type: "string" },
                productUpdates: { type: "string" },
              },
              additionalProperties: false,
            },
            context: {
              type: "object",
              description:
                "Optional HubSpot tracking context (e.g., hutk, pageUri, pageName, ipAddress).",
            },
            hutk: {
              type: "string",
              description: "Optional HubSpot user token (hutk).",
            },
            pageUri: {
              type: "string",
              description: "Optional page URI for tracking context.",
            },
            pageName: {
              type: "string",
              description: "Optional page name for tracking context.",
            },
            ipAddress: {
              type: "string",
              description: "Optional IP address for tracking context.",
            },
            submittedAt: {
              type: "number",
              description:
                "Optional timestamp in milliseconds to set the submission time.",
            },
          },
          required: [
            "firstName",
            "lastName",
            "email",
            "ticketCategory",
            "ticketName",
            "ticketDescription",
            "ticketExtension",
            "extensionVersion",
            "consentConfirmationEmails",
            "consentServiceSupport",
          ],
          additionalProperties: false,
        },
      },
      {
        name: "submit_hubspot_form",
        description:
          "Submits form fields to the HubSpot Forms API (legacy v3 integration endpoint).",
        inputSchema: {
          type: "object",
          properties: {
            portalId: {
              type: "string",
              description:
                "HubSpot portal ID. Required unless HUBSPOT_PORTAL_ID is set.",
            },
            formGuid: {
              type: "string",
              description:
                "HubSpot form GUID. Required unless HUBSPOT_FORM_GUID is set.",
            },
            baseUrl: {
              type: "string",
              description:
                "Override the HubSpot Forms base URL (e.g., https://api.hsforms.com or https://api-eu1.hsforms.com).",
            },
            fields: {
              type: "array",
              description: "Form fields to submit.",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: {
                    oneOf: [
                      { type: "string" },
                      { type: "number" },
                      { type: "boolean" },
                    ],
                  },
                },
                required: ["name", "value"],
                additionalProperties: false,
              },
            },
            context: {
              type: "object",
              description:
                "Optional HubSpot tracking context (e.g., hutk, pageUri, pageName, ipAddress).",
            },
            legalConsentOptions: {
              type: "object",
              description:
                "Optional legal consent payload for GDPR compliance (as required by the form).",
            },
            submittedAt: {
              type: "number",
              description:
                "Optional timestamp in milliseconds to set the submission time.",
            },
          },
          required: ["fields"],
          additionalProperties: false,
        },
      },
      {
        name: "upload_hubspot_form_file",
        description:
          "Uploads a file to the HubSpot form upload endpoint and returns a file URL to use in submissions.",
        inputSchema: {
          type: "object",
          properties: {
            portalId: {
              type: "string",
              description:
                "HubSpot portal ID. Required unless HUBSPOT_PORTAL_ID is set.",
            },
            formGuid: {
              type: "string",
              description:
                "HubSpot form GUID. Required unless HUBSPOT_FORM_GUID is set.",
            },
            baseUrl: {
              type: "string",
              description:
                "Override the HubSpot Forms base URL (e.g., https://api-eu1.hsforms.com).",
            },
            filePath: {
              type: "string",
              description: "Local path to the file to upload.",
            },
            fileName: {
              type: "string",
              description: "Optional filename override for the upload.",
            },
          },
          required: ["filePath"],
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
    }

    if (toolName === "submit_hubspot_form") {
      result = await submitHubspotForm(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (toolName === "submit_support_ticket_form") {
      result = await submitSupportTicketForm(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (toolName === "upload_hubspot_form_file") {
      result = await uploadHubspotFormFile(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
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
