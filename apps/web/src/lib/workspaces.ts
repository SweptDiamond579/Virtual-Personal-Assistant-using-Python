import {
  Activity,
  Bot,
  Brain,
  CalendarClock,
  Code2,
  Cpu,
  Plug,
  Settings,
  ShieldCheck,
  Telescope,
  type LucideIcon,
} from "lucide-react";

export interface Workspace {
  id: string;
  href: string;
  label: string;
  short: string;
  icon: LucideIcon;
  description: string;
}

export const WORKSPACES: Workspace[] = [
  { id: "command", href: "/command/", label: "Command Centre", short: "Command", icon: Cpu, description: "Core, conversation and voice" },
  { id: "mission", href: "/mission/", label: "Mission Control", short: "Mission", icon: Activity, description: "Tasks, agents and approvals" },
  { id: "intelligence", href: "/intelligence/", label: "Intelligence", short: "Intel", icon: Telescope, description: "Research and findings" },
  { id: "development", href: "/development/", label: "Development", short: "Dev", icon: Code2, description: "Repositories, CI and self-analysis" },
  { id: "assistant", href: "/assistant/", label: "Personal Assistant", short: "Assist", icon: Bot, description: "Notes, reminders, briefings, email" },
  { id: "memory", href: "/memory/", label: "Memory Centre", short: "Memory", icon: Brain, description: "What JARVIS remembers" },
  { id: "automation", href: "/automation/", label: "Automation", short: "Auto", icon: CalendarClock, description: "Schedules and workflows" },
  { id: "integrations", href: "/integrations/", label: "Integrations", short: "Links", icon: Plug, description: "Connected services" },
  { id: "security", href: "/security/", label: "Security Centre", short: "Security", icon: ShieldCheck, description: "Approvals, audit and controls" },
  { id: "settings", href: "/settings/", label: "Settings", short: "Settings", icon: Settings, description: "Models, voice and interface" },
];

export function workspaceFor(pathname: string): Workspace | undefined {
  const seg = pathname.split("/").filter(Boolean)[0] ?? "command";
  return WORKSPACES.find((w) => w.id === seg);
}
