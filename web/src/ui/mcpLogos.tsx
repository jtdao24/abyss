// Logos for the Tools drawer. Brand marks come from simple-icons (CC0,
// bundled, so the tool works offline); servers without one get a small
// drawn glyph in a brand-ish colour.
import {
  siAirtable,
  siBrave,
  siDiscord,
  siGit,
  siGithub,
  siGooglemaps,
  siHubspot,
  siModelcontextprotocol,
  siNotion,
  siPostgresql,
  siSqlite,
  siStripe,
  siSupabase,
  siUpstash,
} from "simple-icons";

type Brand = { path: string; hex: string } | { glyph: JSX.Element; hex: string };

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const GLYPHS: Record<string, Brand> = {
  fetch: {
    hex: "0EA5E9",
    glyph: (
      <g {...stroke}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
      </g>
    ),
  },
  playwright: {
    hex: "2EAD33",
    glyph: (
      <g {...stroke}>
        <path d="M4 5c3 1 5 1 8 0v6c0 3-2 5-4 5s-4-2-4-5z" />
        <path d="M12 9c3 1 5 1 8 0v6c0 3-2 5-4 5s-4-2-4-5" />
        <path d="M6.5 9h1M15.5 13h1M6.5 12.5c.8.6 1.7.6 2.5 0M15 17c.8-.6 1.7-.6 2.5 0" />
      </g>
    ),
  },
  filesystem: {
    hex: "F59E0B",
    glyph: <path {...stroke} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  },
  memory: {
    hex: "A855F7",
    glyph: (
      <g {...stroke}>
        <circle cx="6" cy="7" r="2.2" />
        <circle cx="18" cy="6" r="2.2" />
        <circle cx="12" cy="13" r="2.2" />
        <circle cx="6" cy="19" r="2.2" />
        <circle cx="18" cy="18" r="2.2" />
        <path d="M7.8 8.3l2.5 3M16.4 7.5l-2.8 3.9M10.4 14.4l-2.8 3M13.8 14.3l2.6 2.4" />
      </g>
    ),
  },
  "sequential-thinking": {
    hex: "6366F1",
    glyph: (
      <g {...stroke}>
        <path d="M4 18h5v-5h5V8h6" />
        <path d="M17 5l3 3-3 3" />
      </g>
    ),
  },
  time: {
    hex: "14B8A6",
    glyph: (
      <g {...stroke}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </g>
    ),
  },
  slack: {
    hex: "4A154B",
    glyph: (
      <g strokeWidth="3.2" strokeLinecap="round" fill="none">
        <path d="M9.5 3.5v7" stroke="#36C5F0" />
        <path d="M3.5 14.5h7" stroke="#2EB67D" />
        <path d="M14.5 20.5v-7" stroke="#ECB22E" />
        <path d="M20.5 9.5h-7" stroke="#E01E5A" />
      </g>
    ),
  },
  tavily: {
    hex: "0F766E",
    glyph: (
      <g {...stroke}>
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="M15 15l5 5M8 10.5h5M10.5 8v5" />
      </g>
    ),
  },
  exa: {
    hex: "1F40ED",
    glyph: <path {...stroke} d="M17 5H7v14h10M7 12h8" />,
  },
  firecrawl: {
    hex: "FF6B00",
    glyph: (
      <path
        fill="currentColor"
        d="M12 2c1 3.5 5 5.5 5 11a5 5 0 0 1-10 0c0-2.3 1-3.8 2.2-5 .1 1.7.8 2.9 1.8 3.4C11 8.4 10.6 5.3 12 2z"
      />
    ),
  },
};

const ICONS: Record<string, { path: string; hex: string }> = {
  github: siGithub,
  git: siGit,
  "brave-search": siBrave,
  discord: siDiscord,
  notion: siNotion,
  airtable: siAirtable,
  postgres: siPostgresql,
  supabase: siSupabase,
  hubspot: siHubspot,
  "google-maps": siGooglemaps,
  stripe: siStripe,
  sqlite: siSqlite,
  context7: siUpstash,
};

function brandFor(id: string | null): Brand {
  if (id && ICONS[id]) return ICONS[id];
  if (id && GLYPHS[id]) return GLYPHS[id];
  return siModelcontextprotocol; // any other MCP server
}

/** Perceived brightness 0..1 of a hex colour. */
function lightness(hex: string): number {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** A rounded tile with the server's logo. Near-black brands get a light tile. */
export function McpLogo({ id, size = 34 }: { id: string | null; size?: number }) {
  const brand = brandFor(id);
  const dark = lightness(brand.hex) < 0.18;
  const tile = dark ? "#f4efe2" : `#${brand.hex}`;
  const ink = dark ? `#${brand.hex}` : "#ffffff";
  return (
    <span className="mcp-logo" style={{ width: size, height: size, background: tile, color: ink }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58}>
        {"path" in brand ? <path d={brand.path} fill="currentColor" /> : brand.glyph}
      </svg>
    </span>
  );
}
