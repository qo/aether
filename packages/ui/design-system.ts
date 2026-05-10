export const designSystem = {
  color: {
    background: "#0F1117",
    surface: "#181C27",
    border: "#2A2F3E",
    borderStrong: "#3D4356",
    textPrimary: "#E8EAF0",
    textSecondary: "#8B91A8",
    textMuted: "#545A72",
    accent: "#3B82F6",
    accentHover: "#2563EB",
    success: "#22C55E",
    warning: "#F59E0B",
    danger: "#EF4444",
    dataTeal: "#14B8A6",
    dataAmber: "#F59E0B"
  },
  typography: {
    body: "Inter",
    mono: "JetBrains Mono",
    headingWeight: 600,
    bodyWeight: 400,
    labelWeight: 500,
    bodySize: 14,
    labelSize: 11,
    labelTracking: "0.06em",
    headingTracking: "-0.01em"
  },
  spacing: {
    unit: 4,
    cardCompact: 16,
    cardStandard: 24,
    sectionGap: 24,
    sidebarWidth: 240,
    contentMax: 1440,
    rowHeight: 36,
    inputHeight: 36
  },
  radius: {
    card: 6,
    button: 6,
    input: 6,
    badge: 4
  },
  elevation: {
    level0: { fill: "#0F1117" },
    level1: { fill: "#181C27", border: "#2A2F3E" },
    level2: { fill: "#1E2235", border: "#3D4356", shadow: "0 8px 24px rgba(0,0,0,0.24)" },
    level3: { fill: "#232840", border: "#3D4356", shadow: "0 16px 40px rgba(0,0,0,0.32)" }
  }
} as const;
