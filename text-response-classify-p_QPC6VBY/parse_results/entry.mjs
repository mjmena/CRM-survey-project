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

    let text;
    if (typeof response === "string") {
      text = response;
    } else if (response?.content) {
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

    const cleaned = text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "");

    const results = JSON.parse(cleaned);

    $.export("$summary", `Parsed ${results.length} classification results`);
    return { results, results_json: JSON.stringify(results) };
  },
});
