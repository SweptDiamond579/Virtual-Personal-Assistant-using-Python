"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FolderGit2, KeyRound, Laptop, Link2Off, Mail, Plug } from "lucide-react";
import { useState } from "react";
import { DesktopPairing } from "@/components/DesktopPairing";
import { Button, Chip, ErrorNote, FieldLabel, LoadingRows, PageHeader, Panel, statusTone } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface IntegrationInfo {
  id: string;
  name: string;
  implemented: boolean;
  status: string;
  account: string | null;
  auth: string;
  capabilities: string[];
  connected_at?: string | null;
}

const ICONS: Record<string, typeof Plug> = { github: FolderGit2, smtp: Mail, desktop: Laptop, anthropic: Bot };

function GitHubConnect({ info }: { info: IntegrationInfo }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["integrations"] });
  if (info.status === "connected") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-2">Connected as <span className="font-mono text-ice">{info.account}</span> · {dateTime(info.connected_at)}</span>
        <Button variant="danger" className="ml-auto h-7 text-xs" icon={Link2Off} onClick={async () => { await del("/api/integrations/github"); await refresh(); }}>
          Revoke & delete token
        </Button>
      </div>
    );
  }
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post("/api/integrations/github", { token });
          setToken("");
          await refresh();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-xs text-ink-3">
        Public repositories work without a token (rate-limited). For private repos, create a{" "}
        <span className="text-ice">fine-grained personal access token</span> with read-only Contents, Issues, Pull requests and Actions
        (add Issues: write only if you want JARVIS to open issues). The token is validated, encrypted at rest and never shown again.
      </p>
      <FieldLabel htmlFor="gh-token">Personal access token</FieldLabel>
      <div className="flex gap-2">
        <input id="gh-token" type="password" autoComplete="off" className="field font-mono" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={token.length < 20}>Connect</Button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

export default function Integrations() {
  const { data, isLoading } = useQuery({ queryKey: ["integrations"], queryFn: () => get<IntegrationInfo[]>("/api/integrations") });
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Only real connections are shown as connected. Every credential is stored encrypted on the server and can be revoked here."
      />
      {isLoading ? <LoadingRows rows={5} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.map((i) => {
            const Icon = ICONS[i.id] ?? Plug;
            return (
              <Panel key={i.id} title={i.name} icon={Icon} actions={<Chip tone={statusTone(i.status)}>{i.status.replace("_", " ")}</Chip>} className={!i.implemented ? "opacity-70" : undefined}>
                <div className="text-xs text-ink-3">Auth: {i.auth}</div>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {i.capabilities.map((c) => <li key={c}><Chip>{c}</Chip></li>)}
                </ul>
                {i.id === "github" && <GitHubConnect info={i} />}
                {i.id === "smtp" && i.status !== "connected" && (
                  <p className="mt-3 text-xs text-ink-3">Set <span className="font-mono text-ice">SMTP_HOST</span>, <span className="font-mono text-ice">SMTP_USERNAME</span>, <span className="font-mono text-ice">SMTP_PASSWORD</span> and <span className="font-mono text-ice">SMTP_FROM</span> in the server environment (e.g. a Gmail app password) and restart.</p>
                )}
                {i.id === "anthropic" && i.status !== "connected" && (
                  <p className="mt-3 text-xs text-ink-3">Set <span className="font-mono text-ice">ANTHROPIC_API_KEY</span> in the server environment and restart. Keys never reach the browser.</p>
                )}
                {i.id === "desktop" && <div className="mt-3"><DesktopPairing /></div>}
                {!i.implemented && <p className="mt-3 text-xs text-ink-4">Not implemented in this beta. Shown so you know it is planned, not connected.</p>}
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}
