"""MCP servers the Tools panel can add in one click.

Each entry is an mcp.json server spec. `${VAR}` is a secret the user pastes
once (saved to backend/.env, never to mcp.json); `{param}` is a plain setting
filled in when the server is added (a folder, a database path, ...).
`runtime` is the launcher it needs on this machine: "npx" (Node.js), "uvx"
(uv, for Python servers) or None for remote servers.
"""
from __future__ import annotations

CATALOG: list[dict] = [
    # ------------------------------------------------------------ no key needed
    {
        "id": "fetch", "label": "Fetch", "category": "Web",
        "description": "Read any web page as clean text.",
        "runtime": "uvx", "spec": {"command": "uvx", "args": ["mcp-server-fetch"]},
    },
    {
        "id": "playwright", "label": "Playwright browser", "category": "Web",
        "description": "Drive a real (headless) browser: open pages, click, fill forms, take snapshots.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"]},
    },
    {
        "id": "context7", "label": "Context7 docs", "category": "Dev",
        "description": "Up-to-date docs and code examples for thousands of libraries.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]},
    },
    {
        "id": "filesystem", "label": "Filesystem", "category": "Local",
        "description": "Read and write files inside one folder you choose.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "{folder}"]},
        "params": [{"key": "folder", "label": "Folder the vendors may use", "placeholder": "C:\\Users\\you\\Documents\\abyss"}],
    },
    {
        "id": "git", "label": "Git", "category": "Dev",
        "description": "Log, diff, status and search in a local git repository.",
        "runtime": "uvx", "spec": {"command": "uvx", "args": ["mcp-server-git", "--repository", "{repo}"]},
        "params": [{"key": "repo", "label": "Repository folder", "placeholder": "C:\\Users\\you\\code\\project"}],
    },
    {
        "id": "sqlite", "label": "SQLite", "category": "Data",
        "description": "Query and update a local SQLite database.",
        "runtime": "uvx", "spec": {"command": "uvx", "args": ["mcp-server-sqlite", "--db-path", "{db}"]},
        "params": [{"key": "db", "label": "Database file", "placeholder": "C:\\Users\\you\\data\\app.db"}],
    },
    {
        "id": "memory", "label": "Memory", "category": "Local",
        "description": "A knowledge graph the vendors can write to and recall from across sessions.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]},
    },
    {
        "id": "sequential-thinking", "label": "Sequential thinking", "category": "Reasoning",
        "description": "A scratchpad for step-by-step problem solving.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]},
    },
    {
        "id": "time", "label": "Time", "category": "Local",
        "description": "Current time and time-zone conversion.",
        "runtime": "uvx", "spec": {"command": "uvx", "args": ["mcp-server-time"]},
    },
    # ------------------------------------------------------------ search
    {
        "id": "brave-search", "label": "Brave Search", "category": "Search",
        "description": "Web, news and local search.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@brave/brave-search-mcp-server"],
                                   "env": {"BRAVE_API_KEY": "${BRAVE_API_KEY}"}},
        "secrets": [{"var": "BRAVE_API_KEY", "label": "Brave Search API key", "url": "https://brave.com/search/api/"}],
    },
    {
        "id": "tavily", "label": "Tavily", "category": "Search",
        "description": "Search and extract built for AI agents.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "tavily-mcp"], "env": {"TAVILY_API_KEY": "${TAVILY_API_KEY}"}},
        "secrets": [{"var": "TAVILY_API_KEY", "label": "Tavily API key", "url": "https://app.tavily.com"}],
    },
    {
        "id": "exa", "label": "Exa", "category": "Search",
        "description": "Neural web search and page contents.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "exa-mcp-server"], "env": {"EXA_API_KEY": "${EXA_API_KEY}"}},
        "secrets": [{"var": "EXA_API_KEY", "label": "Exa API key", "url": "https://dashboard.exa.ai/api-keys"}],
    },
    {
        "id": "firecrawl", "label": "Firecrawl", "category": "Web",
        "description": "Crawl and scrape whole sites into markdown.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "firecrawl-mcp"], "env": {"FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"}},
        "secrets": [{"var": "FIRECRAWL_API_KEY", "label": "Firecrawl API key", "url": "https://www.firecrawl.dev/app/api-keys"}],
    },
    # ------------------------------------------------------------ work apps
    {
        "id": "github", "label": "GitHub", "category": "Dev",
        "description": "Repos, issues, pull requests and code search (GitHub's official server).",
        "runtime": None, "spec": {"url": "https://api.githubcopilot.com/mcp/",
                                  "headers": {"Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"}},
        "secrets": [{"var": "GITHUB_PERSONAL_ACCESS_TOKEN", "label": "GitHub personal access token",
                     "url": "https://github.com/settings/personal-access-tokens"}],
    },
    {
        "id": "slack", "label": "Slack", "category": "Chat",
        "description": "Read channels and post messages as a bot.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@zencoderai/slack-mcp-server"],
                                   "env": {"SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}", "SLACK_TEAM_ID": "${SLACK_TEAM_ID}"}},
        "secrets": [
            {"var": "SLACK_BOT_TOKEN", "label": "Slack bot token (xoxb-…)", "url": "https://api.slack.com/apps"},
            {"var": "SLACK_TEAM_ID", "label": "Slack workspace (team) ID", "url": "https://api.slack.com/apps"},
        ],
    },
    {
        "id": "discord", "label": "Discord", "category": "Chat",
        "description": "Read and send messages in your Discord server as a bot.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "mcp-discord"], "env": {"DISCORD_TOKEN": "${DISCORD_TOKEN}"}},
        "secrets": [{"var": "DISCORD_TOKEN", "label": "Discord bot token", "url": "https://discord.com/developers/applications"}],
    },
    {
        "id": "notion", "label": "Notion", "category": "Docs",
        "description": "Search, read and write Notion pages and databases.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"],
                                   "env": {"NOTION_TOKEN": "${NOTION_TOKEN}"}},
        "secrets": [{"var": "NOTION_TOKEN", "label": "Notion integration secret", "url": "https://www.notion.so/profile/integrations"}],
    },
    {
        "id": "airtable", "label": "Airtable", "category": "Data",
        "description": "Read and write Airtable bases.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "airtable-mcp-server"],
                                   "env": {"AIRTABLE_API_KEY": "${AIRTABLE_API_KEY}"}},
        "secrets": [{"var": "AIRTABLE_API_KEY", "label": "Airtable personal access token", "url": "https://airtable.com/create/tokens"}],
    },
    {
        "id": "postgres", "label": "Postgres", "category": "Data",
        "description": "Read-only SQL against a Postgres database.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "${POSTGRES_URL}"]},
        "secrets": [{"var": "POSTGRES_URL", "label": "Connection URL (postgresql://user:pass@host/db)", "url": ""}],
    },
    {
        "id": "supabase", "label": "Supabase", "category": "Data",
        "description": "Manage Supabase projects, tables and SQL.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@supabase/mcp-server-supabase@latest", "--read-only"],
                                   "env": {"SUPABASE_ACCESS_TOKEN": "${SUPABASE_ACCESS_TOKEN}"}},
        "secrets": [{"var": "SUPABASE_ACCESS_TOKEN", "label": "Supabase access token", "url": "https://supabase.com/dashboard/account/tokens"}],
    },
    {
        "id": "hubspot", "label": "HubSpot", "category": "Sales",
        "description": "Contacts, companies and deals in your HubSpot CRM.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@hubspot/mcp-server"],
                                   "env": {"PRIVATE_APP_ACCESS_TOKEN": "${HUBSPOT_PRIVATE_APP_TOKEN}"}},
        "secrets": [{"var": "HUBSPOT_PRIVATE_APP_TOKEN", "label": "HubSpot private app token",
                     "url": "https://developers.hubspot.com/docs/api/private-apps"}],
    },
    {
        "id": "google-maps", "label": "Google Maps", "category": "Search",
        "description": "Places, directions, distances and geocoding.",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-google-maps"],
                                   "env": {"GOOGLE_MAPS_API_KEY": "${GOOGLE_MAPS_API_KEY}"}},
        "secrets": [{"var": "GOOGLE_MAPS_API_KEY", "label": "Google Maps API key",
                     "url": "https://console.cloud.google.com/google/maps-apis/credentials"}],
    },
    {
        "id": "stripe", "label": "Stripe", "category": "Sales",
        "description": "Customers, products, invoices and payments (use a test-mode or restricted key).",
        "runtime": "npx", "spec": {"command": "npx", "args": ["-y", "@stripe/mcp", "--tools=all"],
                                   "env": {"STRIPE_SECRET_KEY": "${STRIPE_SECRET_KEY}"}},
        "secrets": [{"var": "STRIPE_SECRET_KEY", "label": "Stripe restricted/test key", "url": "https://dashboard.stripe.com/apikeys"}],
    },
]

BY_ID = {entry["id"]: entry for entry in CATALOG}
