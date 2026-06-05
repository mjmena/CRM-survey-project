# How survey-response demographics are associated

*Audience: CRM and marketing stakeholders. This page explains, in plain language, how
a person's demographic profile gets attached to the survey answers they gave — and the
privacy guarantees that bound it. No technical background needed.*

---

## The short version

When someone answers one of our surveys, we want to understand **who** answered — their
age range, where they live, household profile, and so on — without ever handling their
personal contact details. We do this in four steps:

1. **A response comes in.** Someone answers a survey question.
2. **We match the response to a person.** Using a scrambled (one-way "hashed") version of
   their email — never the real email address.
3. **We look up that person's demographics** from a third-party data provider, **Audience
   Acuity**.
4. **We attach those demographics to the response** so the answer and the profile sit
   together in reporting.

The result is that each survey answer can be read alongside a non-identifying profile of
the person who gave it — useful for understanding *which kinds of readers* hold which views,
buy which things, or follow which topics.

---

## Step by step

### 1. A response comes in

Every survey submission is captured as a response. From this point on, the goal is to
enrich that response with a demographic profile — but only if we can confidently tie it to
a person.

### 2. Matching a response to a person

This is the step that makes everything else possible, and it's worth understanding because
it's where coverage is won or lost.

We identify the person behind a response in one of two ways:

- **Directly** — if a scrambled email was captured along with the response, we use that.
- **By recovery** — if it wasn't, we recover it from the person's own activity on our sites
  around the time they took the survey.

That second path matters a great deal. On its own, the directly-captured email only covers a
minority of responses; the recovery path lifts coverage substantially, so that the large
majority of responses can be tied to a person. To keep this accurate and bounded, the
recovery looks **only at activity within the survey's own time window** — not a person's
broader history.

Throughout, the email we work with is always a **one-way hashed value**. We never use or
store a real email address at any point.

### 3. Looking up demographics

Once a response is tied to a (hashed) person, we match that person against **Audience
Acuity**, a third-party consumer-data provider, and pull a **fixed set of non-identifying
attributes**:

- Age range
- Income and net-worth ranges
- Education
- Occupation
- Marital status
- Homeowner status
- Ethnicity
- Whether there are children in the household
- Gender
- State and media market (DMA)
- A small set of broad interest/affinity flags

These are **ranges, categories, and flags** — descriptive bands, not precise personal facts.

### 4. Attaching demographics to the response

Finally, the demographic profile is joined back onto the response, so that each answer and
its profile travel together into reporting.

> **Privacy — what we do and don't handle**
>
> - We work only from a **one-way hashed** email. We never use, store, or match on a real
>   email address at any point.
> - The demographic profile **never** includes a person's **name, street address, ZIP code,
>   precise location (latitude/longitude), or email** — only the non-identifying ranges,
>   categories, and flags listed above.
> - In other words: we can say *"this answer came from someone in a particular age range,
>   income band, and state,"* but never *who* that someone is.

---

## How good is the coverage?

Not every response can be enriched, and that's expected — but the reason is often the
opposite of what people assume.

**Tying a response to a person almost always works.** Between the directly-captured email
and the recovery path, the large majority of responses are matched to a person. That is *not*
where coverage is usually lost.

The more common reason a response ends up without a profile is on the **data-provider
side**: either the person isn't in Audience Acuity's data at all, or Audience Acuity simply
doesn't hold a given attribute for them. So a blank demographic field usually means *"the
provider had no match — or no value — for this person,"* not *"we couldn't tell who
answered."*

Importantly, **responses we can't enrich are never dropped.** They still appear in
reporting, simply with the demographic columns left blank. So the totals always reflect
*every* response — enrichment is additive, not a filter.

---

## Where this shows up

Today, the enriched data surfaces in the **per-survey Google Sheet**: each survey has its
own tab, and the demographic columns sit to the right of the answer columns, so you can read
an answer and the responder's profile on the same row.
