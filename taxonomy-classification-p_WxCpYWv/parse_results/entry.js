export default defineComponent({
  name: "Parse Results",
  description:
    "Parses Claude's JSON response into structured classification results.",
  props: {
    ai_response: {
      type: "any",
      label: "AI Response",
      description: "Raw response from the Claude send message step",
    },
  },
  async run({ $ }) {
    const response = this.ai_response;

    // Extract text from the response — handle both direct string
    // and Pipedream's Anthropic action response format
    let text;
    if (typeof response === "string") {
      text = response;
    } else if (response?.content) {
      // Standard Anthropic API response shape
      text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    } else if (response?.$return_value?.content) {
      text = response.$return_value.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    } else {
      throw new Error(
        "Could not extract text from AI response: " +
          JSON.stringify(response).slice(0, 200)
      );
    }

    // Strip markdown fencing if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");

    const results = JSON.parse(cleaned);

    $.export("$summary", `Parsed ${results.length} classification results`);
    return { results, results_json: JSON.stringify(results) };
  },
});
