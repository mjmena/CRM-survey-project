const TOOL_SCHEMAS = [
  {
    name: "get_survey_catalog",
    description:
      "Fetch survey questions and answer options from DIM_SURVEY_CATALOG. Returns all polls or filters by poll_id.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: {
          type: "string",
          description: "Optional. Filter to a specific poll. Omit to return all polls.",
        },
      },
    },
  },
  {
    name: "get_taxonomy",
    description:
      "Fetch AI-generated taxonomy classifications from DIM_SURVEY_TAXONOMY. Supports optional filters by poll_id, bucket, and minimum confidence score.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "Optional. Filter to a specific poll." },
        bucket: {
          type: "string",
          enum: ["consumption", "preference", "demographic"],
          description: "Optional. Filter to a specific taxonomy bucket.",
        },
        min_confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Optional. Only return rows with CONFIDENCE >= this value.",
        },
      },
    },
  },
  {
    name: "get_survey_responses",
    description:
      "Return per-question answer tally counts and percentages for a specific poll from STG_SURVEY_RESPONSES.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "The poll_id to tally responses for." },
      },
      required: ["poll_id"],
    },
  },
  {
    name: "create_poll",
    description:
      "Create a new poll entry in the Braze crm_surveys catalog. The poll_id becomes the catalog item id.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: {
          type: "string",
          description: "Unique identifier for the new poll (becomes catalog item id).",
        },
        definition: {
          type: "object",
          description:
            "Survey definition object. Must include a 'questions' map following the v2 catalog format: { questions: { <key>: { question: string, options: [{ value, label, is_catch_all? }] } } }",
        },
      },
      required: ["poll_id", "definition"],
    },
  },
  {
    name: "update_poll",
    description:
      "Update an existing poll entry in the Braze crm_surveys catalog by poll_id.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "The poll_id (catalog item id) to update." },
        definition: {
          type: "object",
          description: "Replacement survey definition object.",
        },
      },
      required: ["poll_id", "definition"],
    },
  },
  {
    name: "duplicate_campaign",
    description:
      "Duplicate the configured Braze template campaign with a new name. The source campaign_id is stored in workflow config — callers only supply the name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the new duplicate campaign." },
        description: { type: "string", description: "Optional description." },
      },
      required: ["name"],
    },
  },
];

const SNOWFLAKE_TOOLS = new Set(["get_survey_catalog", "get_taxonomy", "get_survey_responses"]);
const BRAZE_TOOLS = new Set(["create_poll", "update_poll", "duplicate_campaign"]);

export default defineComponent({
  name: "Parse and Dispatch",
  description:
    "Authenticates MCP requests, handles all non-Snowflake paths inline, and passes Snowflake tool calls to downstream steps.",
  props: {
    braze: { type: "app", app: "braze" },
    mcp_shared_secret: { type: "string", secret: true, label: "MCP Shared Secret" },
    template_campaign_id: { type: "string", label: "Template Campaign ID" },
  },

  async run({ steps, $ }) {
    const event = steps.trigger.event;
    const body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body ?? {});

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader =
      event.headers?.authorization ?? event.headers?.Authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || token !== this.mcp_shared_secret) {
      await $.respond({
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32600, message: "Unauthorized" },
        }),
      });
      $.flow.exit("Unauthorized");
    }

    const { method, id: requestId, params } = body;

    // ── ping — respond before auth to avoid per-second workflow invocations ───
    if (method === "ping") {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, result: {} }),
      });
      $.flow.exit("handled: ping");
    }

    // ── initialize ────────────────────────────────────────────────────────────
    if (method === "initialize") {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "prism-mcp", version: "1.0.0" },
          },
        }),
      });
      $.flow.exit("handled: initialize");
    }

    // ── notifications/initialized (no id — notification, not a request) ───────
    if (method === "notifications/initialized") {
      await $.respond({ status: 202, headers: {}, body: "" });
      $.flow.exit("handled: notifications/initialized");
    }

    // ── tools/list ────────────────────────────────────────────────────────────
    if (method === "tools/list") {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: { tools: TOOL_SCHEMAS },
        }),
      });
      $.flow.exit("handled: tools/list");
    }

    // ── tools/call ────────────────────────────────────────────────────────────
    if (method !== "tools/call") {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32601, message: `Method not found: ${method}` },
        }),
      });
      $.flow.exit("unknown method");
    }

    const tool = params?.name;
    const args = params?.arguments ?? {};

    if (!tool) {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32602, message: "tools/call missing params.name" },
        }),
      });
      $.flow.exit("missing tool name");
    }

    // ── Braze tools — handle inline, no Snowflake needed ─────────────────────
    if (BRAZE_TOOLS.has(tool)) {
      const result = await handleBrazeTool(
        tool,
        args,
        this.braze.$auth,
        this.template_campaign_id
      );
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
            isError: result.isError,
          },
        }),
      });
      $.flow.exit(`handled: ${tool}`);
    }

    // ── Unknown tool ──────────────────────────────────────────────────────────
    if (!SNOWFLAKE_TOOLS.has(tool)) {
      await $.respond({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32602, message: `Unknown tool: ${tool}` },
        }),
      });
      $.flow.exit("unknown tool");
    }

    // ── Snowflake tools — pass context to downstream steps ───────────────────
    return { tool, args, requestId };
  },
});

// ── Braze API helpers ─────────────────────────────────────────────────────────

async function handleBrazeTool(tool, args, brazeAuth, templateCampaignId) {
  const { instance_domain, region, api_key } = brazeAuth;
  const baseURL = `https://${instance_domain}.braze.${region}`;
  const headers = {
    Authorization: `Bearer ${api_key}`,
    "Content-Type": "application/json",
  };

  let resp, data;

  if (tool === "create_poll") {
    const { poll_id, definition } = args;
    if (!poll_id) return { isError: true, body: { error: "poll_id is required" } };
    if (!definition) return { isError: true, body: { error: "definition is required" } };
    resp = await fetch(`${baseURL}/catalogs/crm_surveys/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ id: poll_id, definition }] }),
    });
    data = await resp.json();
    return { isError: !resp.ok, body: data };
  }

  if (tool === "update_poll") {
    const { poll_id, definition } = args;
    if (!poll_id) return { isError: true, body: { error: "poll_id is required" } };
    if (!definition) return { isError: true, body: { error: "definition is required" } };
    resp = await fetch(
      `${baseURL}/catalogs/crm_surveys/items/${encodeURIComponent(poll_id)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ items: [{ id: poll_id, definition }] }),
      }
    );
    data = await resp.json();
    return { isError: !resp.ok, body: data };
  }

  if (tool === "duplicate_campaign") {
    const { name, description } = args;
    if (!name) return { isError: true, body: { error: "name is required" } };
    if (!templateCampaignId) {
      return {
        isError: true,
        body: { error: "template_campaign_id is not configured in workflow props" },
      };
    }
    resp = await fetch(`${baseURL}/campaigns/duplicate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        campaign_id: templateCampaignId,
        name,
        ...(description ? { description } : {}),
      }),
    });
    data = await resp.json();
    return { isError: !resp.ok, body: data };
  }

  return { isError: true, body: { error: `Unhandled Braze tool: ${tool}` } };
}
