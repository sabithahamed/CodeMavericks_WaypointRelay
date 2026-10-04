# AI tool disclosure: Hackathon

## Tools used

| Tool | Used for |
|---|---|
| Claude Code (Anthropic) | Writing the application code, tests, Docker and deployment configuration, and documentation. |

## AI-assisted work

- **Code:** the planning engine, the API, the database schema and seed, the web app screens, and the offline sync were generated with Claude Code from our Designathon specification, then reviewed and tested by the team.
- **Tests:** the planner was specified as tests first, using the booklet's worked examples (101 min trip, VEH036 64/40 min trips, the 55.7 kg overweight case, the S1-078 oversize order). An end-to-end test covers all four roles. The S1 allocation was checked independently with the organisers' `check_allocation.py`.
- **Docs:** the README, architecture, data model and this disclosure were drafted with AI and edited by the team.

## Not AI-assisted

- The product concept, scope and screen flows (our Designathon submission), which served as the build specification.
- Product and engineering decisions: what to build, keeping the datasets out of the public repository, and the hosting choice.
- Reviewing and testing the running app across all four roles, setting up deployment (GitHub, Render, Supabase), and the demo video voice-over.
