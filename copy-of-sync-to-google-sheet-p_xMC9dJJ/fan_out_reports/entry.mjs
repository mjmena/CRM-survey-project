// Orchestrator step (ADR-0003). On its timer, fans the survey→sheet MAPPING out
// to the report-one-survey worker, POSTing {poll_id, spreadsheet_id} per entry —
// the same explicit-handoff pattern as migration/fire_backfill.sh and ADR-0001.
// One survey per worker run keeps each payload inherently under the 128 MB cap.
//
// MAPPING is the single source of truth for which surveys report to which sheet.
// To add/remove a survey or repoint a sheet, edit this array and push.

// The worker's HTTP endpoint (dc_MDuJLd2 on p_LQCoVRY "Report One Survey").
const WORKER_ENDPOINT = "https://767afff09429009443b99a7fc1c2f5f5.m.pipedream.net";

const SHEETS = {
  // "Sync to Google Sheet" sheet — CRM in-article/landing-page surveys.
  crm: "19pUJyXDsmDRjZSRaMxpAdLj1ZxVZqA5ByAjsJF2GFxM",
  // "Surveyfast Sync to Google Sheet" sheet — SurveyFast generation polls.
  surveyfast: "1ycxK2pQPKOsQ_zoSo88Cyqih4aDHlcnvm4qRYjR7Ck4",
};

// Curated per ADR-0003 (issue #12): substantive surveys only — test/template
// polls and tiny (<~100 response) strays are intentionally omitted.
const MAPPING = [
  // CRM surveys → crm sheet
  { poll_id: "crm-politics-undecided-voters-poll", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_api_retirement_cohort_segments_survey_2026_iam_segment-a", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_api_retirement_cohort_segments_survey_2026_iam_segment-b", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_api_retirement_cohort_segments_survey_2026_iam_segment-c", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_api_retirement_survey_2026_iam", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_olympic_vibes_survey_2026_iam", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_sports_team_survey_iam", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_march_madness_survey_2026_iam", spreadsheet_id: SHEETS.crm },
  { poll_id: "crm_fifa_world_cup_survey_2026_iam", spreadsheet_id: SHEETS.crm },
  // SurveyFast generation polls → surveyfast sheet
  { poll_id: "sf-generation-life-spice-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-privacy-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-status-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-trust-flip-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-analog-split-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-fun-shift-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-hustle-culture-poll", spreadsheet_id: SHEETS.surveyfast },
  { poll_id: "sf-generation-competence-comeback-poll", spreadsheet_id: SHEETS.surveyfast },
];

export default defineComponent({
  name: "Fan Out Per-Survey Reports",
  description:
    "Timer-driven. POSTs {poll_id, spreadsheet_id} to the report-one-survey worker for each entry in the survey→sheet mapping. A per-survey failure is isolated (collected) and surfaced by throwing at the end — never silently swallowed.",
  async run({ $ }) {
    const results = [];
    const failures = [];

    // Sequential so we don't fire all worker runs in one burst. Each POST is
    // fire-and-forget (the worker's http source self-responds, then runs async),
    // so a 2xx means "accepted" — the worker's own error_notification surfaces a
    // failed sheet write. Resync (ADR-0003) self-heals any first-run tab races.
    for (const { poll_id, spreadsheet_id } of MAPPING) {
      try {
        const resp = await fetch(WORKER_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poll_id, spreadsheet_id }),
        });
        if (!resp.ok) {
          failures.push(`${poll_id}: HTTP ${resp.status}`);
        } else {
          results.push(poll_id);
        }
      } catch (err) {
        failures.push(`${poll_id}: ${err.message}`);
      }
    }

    $.export(
      "$summary",
      `Dispatched ${results.length}/${MAPPING.length} survey reports` +
        (failures.length ? `; ${failures.length} failed` : "")
    );

    if (failures.length) {
      throw new Error(`Failed to dispatch ${failures.length} survey report(s): ${failures.join("; ")}`);
    }

    return { dispatched: results, count: results.length };
  },
});
