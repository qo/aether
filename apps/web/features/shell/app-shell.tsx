"use client";

/**
 * AppShell — the single sidebar + topbar that wraps every route. Mounted
 * once from app/layout.tsx so the chrome is identical on /home, /raw, /3d,
 * /devices-v2 etc. Pages render their content into the .shell-content slot.
 *
 * Embed mode: any route loaded with ?embed=1 (the popped-out 3D view) is
 * rendered without the shell, so the visualization gets the full viewport.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Boxes,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  Settings,
  Waves,
} from "lucide-react";
import { getHealth } from "../../lib/api";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  match?: (pathname: string) => boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: "MONITORING",
    items: [
      {
        href: "/home",
        label: "Live Room",
        icon: <LayoutDashboard size={12} strokeWidth={1.6} />,
        match: (p) => p === "/" || p.startsWith("/home"),
      },
    ],
  },
  {
    label: "DIAGNOSTICS",
    items: [
      { href: "/raw", label: "Raw Sensor", icon: <Activity size={12} strokeWidth={1.6} /> },
      { href: "/3d", label: "3D Wave View", icon: <Waves size={12} strokeWidth={1.6} /> },
      { href: "/devices-v2", label: "Devices", icon: <Cpu size={12} strokeWidth={1.6} /> },
    ],
  },
  {
    label: "RESEARCH",
    items: [
      {
        href: "/home?page=Experiment+Console",
        label: "Experiments",
        icon: <FlaskConical size={12} strokeWidth={1.6} />,
      },
      {
        href: "/home?page=Data+Explorer",
        label: "Data Explorer",
        icon: <Boxes size={12} strokeWidth={1.6} />,
      },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      {
        href: "/home?page=Settings",
        label: "Settings",
        icon: <Settings size={12} strokeWidth={1.6} />,
      },
    ],
  },
];

const CRUMB_FOR_PATH: Record<string, string> = {
  "/home": "Live Room",
  "/raw": "Raw Sensor",
  "/3d": "3D Wave View",
  "/devices-v2": "Devices",
};

type ApiStatus = "checking" | "online" | "offline";

function useApiHealth(): { status: ApiStatus; mode: string | null } {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const h = await getHealth();
        if (cancelled) return;
        setStatus(h.status === "ok" || h.status === "healthy" ? "online" : "offline");
        setMode(h.source_mode ?? null);
      } catch {
        if (cancelled) return;
        setStatus("offline");
        setMode(null);
      } finally {
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { status, mode };
}

function ShellSidebar({ pathname }: { pathname: string }) {
  return (
    <aside className="shell-sidebar" aria-label="Aether navigation">
      <div className="shell-brand">
        <span className="mark" aria-hidden />
        AETHER
        <span className="ver">v0.2</span>
      </div>
      <nav className="shell-nav">
        {SECTIONS.map((section) => (
          <div key={section.label} className="shell-nav-section">
            <span className="shell-nav-label">{section.label}</span>
            {section.items.map((item) => {
              const isActive = item.match
                ? item.match(pathname)
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`shell-nav-item${isActive ? " is-active" : ""}`}
                >
                  <span className="icon">{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="shell-sidebar-footer">
        LOCAL-FIRST · NO CLOUD
        <br />
        NO IDENTITY OR MEDICAL CLAIMS
      </div>
    </aside>
  );
}

function ShellTopBar({ pathname }: { pathname: string }) {
  const crumb =
    CRUMB_FOR_PATH[pathname] ??
    Object.entries(CRUMB_FOR_PATH).find(([p]) => pathname.startsWith(p))?.[1] ??
    "Console";
  const { status, mode } = useApiHealth();
  const dotClass =
    status === "online" ? "good" : status === "offline" ? "danger" : "warn";
  const label =
    status === "online"
      ? `API ONLINE${mode ? ` · ${mode.toUpperCase()}` : ""}`
      : status === "offline"
      ? "API OFFLINE"
      : "API CHECKING…";
  return (
    <header className="shell-topbar">
      <div className="shell-crumb">
        AETHER / <strong>{crumb}</strong>
      </div>
      <div className="shell-topbar-spacer" />
      <div className="shell-topbar-status">
        <span className={`dot ${dotClass}`} aria-hidden />
        <span>{label}</span>
      </div>
    </header>
  );
}

function InnerShell({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const pathname = usePathname() ?? "/";
  const embed = params?.get("embed") === "1";
  if (embed) {
    return <div className="shell-embed">{children}</div>;
  }
  return (
    <div className="shell">
      <ShellSidebar pathname={pathname} />
      <main className="shell-main">
        <ShellTopBar pathname={pathname} />
        <div className="shell-content">{children}</div>
      </main>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="shell-content">Loading…</div>}>
      <InnerShell>{children}</InnerShell>
    </Suspense>
  );
}
