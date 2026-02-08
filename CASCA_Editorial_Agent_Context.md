# CASCA Editorial Agent — Context & System Blueprint

## Purpose

This application is an editorial discovery and publishing assistant for CASCA Archive.  
Its mission is to identify, verify, and editorialize stories of visual artists from the Northeast of Brazil, producing Medium-style articles in English with strict editorial control.

The system is human-in-the-loop: nothing is published automatically. Publishing only happens after explicit approval via email.

---

## Core Principles (Non‑Negotiable)

- Only visual artists (painting, engraving, photography, sculpture, printmaking, visual installations)
- Only artists born in or strongly rooted in Northeast Brazil
- High‑trust sources only (museums, universities, cultural institutions, major publications)
- No speculation, no invented quotes, no social‑media‑only sources
- English language output only
- Editorial tone: calm, factual, cultural — never hype

---

## High‑Level System Flow

1. Discover candidates  
2. Verify identity and eligibility  
3. Synthesize editorial content  
4. Prepare visual materials  
5. Send daily editorial email  
6. Await human command  
7. Publish to Medium only on explicit approval

---

## 1. Discovery Layer

Goal: Identify potential artists and relevant stories.

Inputs:
- Web and academic search APIs
- Whitelisted institutional domains

Rules:
- Discovery never writes content
- It only gathers facts and references

Required output per candidate:
- Artist full name
- Birthplace (city + state)
- Visual practice
- Minimum two independent reputable sources

If any field is missing, discard the candidate.

---

## 2. Verification & Eligibility Filter

Before any content generation, all candidates must pass the following checklist:

Eligibility:
- Artist is primarily a visual artist
- Origin confirmed as Northeast Brazil
- At least two trusted sources confirm relevance
- Not primarily known as musician, writer, performer, or influencer

Verification rules:
- Cross‑check birthplace and career across sources
- Flag living vs deceased (affects tone only)

If verification fails, discard completely.

---

## 3. Content Synthesis (Editorial Writing)

Goal: Produce a Medium‑ready article draft.

Constraints:
- Language: English
- Style: editorial, informative, restrained
- No invented facts or quotes
- Uncertain information must be omitted

Medium‑style structure:
- Title
- Subtitle
- Short introduction
- Two to four short thematic sections
- “Why this artist matters now”
- Sources & references section

LLMs are used only for synthesis, never for discovery or verification.

---

## 4. Visual Materials

Goal: Provide safe, credited visuals for editorial use.

Allowed sources:
- Wikimedia Commons
- Museum or institutional archives
- University or cultural foundation press materials

Rules:
- Never scrape social media automatically
- Always include captions and source credits
- Note editorial‑only usage restrictions when applicable

Each post should include two to four images maximum.

---

## 5. Daily Editorial Email

Purpose: Serve as the approval interface.

Frequency:
- One email per day maximum

Email contents:
- Subject: “CASCA Daily — [Artist Name]”
- Full article text
- Embedded or linked images
- Source list
- Clear instruction line:
  Reply with “poste” to publish on Medium.

No other reply triggers publishing.

---

## 6. Human‑in‑the‑Loop Publishing

Publishing happens only if:
- The email reply body contains exactly the word: poste

Any other reply:
- Does nothing
- Is logged for reference

This guarantees editorial control.

---

## 7. Medium Publishing Strategy

- No stable public write API should be assumed
- Publishing failures must not affect discovery or email flows
- Drafts must always be preserved

If publishing fails:
- Log the error
- Notify the editor
- Preserve the draft for later retry

---

## Infrastructure & Deployment

Orchestration:
- OpenClaw running on a Mac Mini

Hosting:
- Vercel for lightweight services and endpoints

Core services:
- Search APIs for discovery
- LLM for synthesis only
- Transactional email service with inbound parsing

Storage:
- Artists already covered
- Sources
- Drafts
- Publishing status

---

## Failure‑Tolerance Philosophy

The system must always prefer:
- Publishing nothing over publishing something wrong
- Fewer posts over lower credibility
- Editorial silence over uncertainty

CASCA’s value is trust, not volume.

---

## Summary

This application is not a content farm.

It is an editorial assistant designed to surface overlooked visual artists from Northeast Brazil with care, rigor, and cultural responsibility — while keeping a human editor firmly in control.
