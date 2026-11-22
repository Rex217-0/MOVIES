# OpenHands project context

Start with [`docs/INDEX.md`](docs/INDEX.md) — it maps every document to the
question it answers, and says where each build artifact goes (`dist/` is
gitignored and rebuilt by Docker; `android/movie-creator.apk` is committed on
purpose and must stay out of `.dockerignore`).

Before changing Firebase or Google Cloud code, read [`docs/CLOUD_PROGRESS.md`](docs/CLOUD_PROGRESS.md) and the related setup docs. This repository already contains work from the project owner and other contributors/agents; do not assume a feature is yours to create from scratch. Inspect the current implementation, preserve working behavior, and update the progress note when cloud-related work changes.

Before wiring this app to any external agent or worker, read [`docs/manus-handoff.md`](docs/manus-handoff.md). It lists the environment variables that are actually read, the endpoints that actually exist, and four widely repeated instructions that do not match the code.

When describing progress, separate what is implemented in this repository from what has been verified live in Firebase or Google Cloud Console. Never claim a deployment, OAuth authorization, or successful cloud operation unless it has actually been checked. Never commit secrets, service-account keys, OAuth client secrets, access tokens, or refresh tokens.
