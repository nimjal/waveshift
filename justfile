build:    # curated targets -> web/public/data
    cd py && uv run python -m planetx.cli build
api:      # local API on :7860
    cd py && uv run uvicorn planetx.api:app --port 7860 --reload
web:
    cd web && npm run dev
lint:
    cd web && npx oxlint
