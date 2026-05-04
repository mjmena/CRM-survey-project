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
    name: "get_poll",
    description:
      "Fetch a single poll row from the crm_prism_surveys catalog by poll_id. Returns id, definition (parsed object), intro_html, and outro_html.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "The poll_id (catalog item id) to fetch." },
      },
      required: ["poll_id"],
    },
  },
  {
    name: "create_poll",
    description:
      "Create a new poll entry in the Braze crm_prism_surveys catalog. Accepts the definition as an object — stringification is handled automatically.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: {
          type: "string",
          description: "Unique identifier for the new poll (becomes catalog item id). Convention: prism_<topic>_<year>_survey.",
        },
        definition: {
          type: "object",
          description: "v2 survey definition object with poll_id, version, title, pages, and questions.",
        },
        intro_html: {
          type: "string",
          description: "Liquid-evaluated HTML for the page 1 header. Personalization tokens like {{ ${first_name} }} work here.",
        },
        outro_html: {
          type: "string",
          description: "Liquid-evaluated HTML for the results/thanks screen. Must contain <div data-results-slot></div>.",
        },
      },
      required: ["poll_id", "definition", "intro_html", "outro_html"],
    },
  },
  {
    name: "update_poll",
    description:
      "Update an existing poll entry in the crm_prism_surveys catalog by poll_id. Pass only the fields you want to change. Always bump definition.version.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "The poll_id (catalog item id) to update." },
        definition: {
          type: "object",
          description: "Replacement v2 survey definition object. Must have version bumped by 1.",
        },
        intro_html: { type: "string", description: "Replacement intro HTML." },
        outro_html: { type: "string", description: "Replacement outro HTML. Must contain <div data-results-slot></div>." },
      },
      required: ["poll_id"],
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
  {
    name: "get_text_answers",
    description:
      "Fetch unique normalized free-text responses stored in DIM_SURVEY_OPTIONS with OPTION_SOURCE='response'. Optionally filter to a specific poll or to unclassified rows only.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "Optional. Filter to a specific poll." },
        unclassified_only: {
          type: "boolean",
          description: "Optional. If true, only return text answers not yet classified in DIM_SURVEY_TAXONOMY.",
        },
      },
    },
  },
  {
    name: "get_answer_patterns",
    description:
      "Fetch co-occurrence and page-order statistics for a poll — which predefined option pairs appear together most often in the same submission, and in which sequence. Use this to identify candidates for conditional taxonomy rules.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "The poll_id to analyze." },
      },
      required: ["poll_id"],
    },
  },
  {
    name: "create_taxonomy_rule",
    description:
      "Insert a conditional or unconditional taxonomy rule into DIM_SURVEY_TAXONOMY for a specific catalog option. Resolves the option to its OPTION_ID automatically. For conditional rules, pass condition_option_ids as an ordered array of OPTION_IDs that must co-occur in the same submission (in ascending page order) for this rule to fire.",
    inputSchema: {
      type: "object",
      properties: {
        poll_id: { type: "string", description: "Poll the option belongs to." },
        question_key: { type: "string", description: "Question key of the option." },
        option_value: { type: "string", description: "The option value exactly as stored in DIM_SURVEY_OPTIONS." },
        bucket: {
          type: "string",
          enum: ["consumption", "preference", "demographic"],
          description: "Taxonomy bucket.",
        },
        taxonomy_path: {
          type: "string",
          description: "Pipe-delimited taxonomy path (consumption/preference). e.g. 'Sports|Basketball|Active Fan'.",
        },
        demographic_key: { type: "string", description: "Demographic key in snake_case (demographic bucket only)." },
        demographic_value: { type: "string", description: "Demographic value (demographic bucket only)." },
        demographic_type: {
          type: "string",
          enum: ["string", "boolean", "number"],
          description: "Demographic value type (demographic bucket only).",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence score 0.0–1.0.",
        },
        condition_option_ids: {
          type: "array",
          items: { type: "number" },
          description:
            "Optional. Ordered array of OPTION_IDs that must appear in the same submission (in this page order) for the rule to fire. Omit or pass [] for unconditional rules.",
        },
      },
      required: ["poll_id", "question_key", "option_value", "bucket", "confidence"],
    },
  },
];

const SNOWFLAKE_TOOLS = new Set(["get_survey_catalog", "get_taxonomy", "get_survey_responses", "get_text_answers", "get_answer_patterns", "create_taxonomy_rule"]);
const CATALOG_TOOLS = new Set(["get_poll", "create_poll", "update_poll"]);
const CAMPAIGN_TOOLS = new Set(["duplicate_campaign"]);

export default defineComponent({
  name: "Parse and Dispatch",
  description:
    "Authenticates MCP requests, handles all non-Snowflake paths inline, and passes Snowflake tool calls to downstream steps.",
  props: {
    braze_campaign: { type: "app", app: "braze", label: "Braze (Campaign)" },
    braze_catalog: { type: "app", app: "braze", label: "Braze (Catalog)" },
    template_campaign_id: { type: "string", label: "Template Campaign ID" },
  },

  async run({ steps, $ }) {
    const event = steps.trigger.event;
    const body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body ?? {});

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
            protocolVersion: "2025-03-26",
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
    if (CATALOG_TOOLS.has(tool) || CAMPAIGN_TOOLS.has(tool)) {
      const auth = CATALOG_TOOLS.has(tool) ? this.braze_catalog.$auth : this.braze_campaign.$auth;
      const result = await handleBrazeTool(
        tool,
        args,
        auth,
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

  if (tool === "get_poll") {
    const { poll_id } = args;
    if (!poll_id) return { isError: true, body: { error: "poll_id is required" } };
    resp = await fetch(
      `${baseURL}/catalogs/crm_prism_surveys/items/${encodeURIComponent(poll_id)}`,
      { headers }
    );
    data = await resp.json();
    if (resp.ok && data.item?.definition) {
      try { data.item.definition = JSON.parse(data.item.definition); } catch {}
    }
    return { isError: !resp.ok, body: data };
  }

  if (tool === "create_poll") {
    const { poll_id, definition, intro_html, outro_html } = args;
    if (!poll_id) return { isError: true, body: { error: "poll_id is required" } };
    if (!definition) return { isError: true, body: { error: "definition is required" } };
    if (!intro_html) return { isError: true, body: { error: "intro_html is required" } };
    if (!outro_html) return { isError: true, body: { error: "outro_html is required" } };
    const defStr = typeof definition === "string" ? definition : JSON.stringify(definition);
    resp = await fetch(`${baseURL}/catalogs/crm_prism_surveys/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ id: poll_id, definition: defStr, intro_html, outro_html }] }),
    });
    data = await resp.json();
    return { isError: !resp.ok, body: data };
  }

  if (tool === "update_poll") {
    const { poll_id, definition, intro_html, outro_html } = args;
    if (!poll_id) return { isError: true, body: { error: "poll_id is required" } };
    const patch = { id: poll_id };
    if (definition !== undefined) patch.definition = typeof definition === "string" ? definition : JSON.stringify(definition);
    if (intro_html !== undefined) patch.intro_html = intro_html;
    if (outro_html !== undefined) patch.outro_html = outro_html;
    resp = await fetch(
      `${baseURL}/catalogs/crm_prism_surveys/items/${encodeURIComponent(poll_id)}`,
      { method: "PATCH", headers, body: JSON.stringify({ items: [patch] }) }
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
