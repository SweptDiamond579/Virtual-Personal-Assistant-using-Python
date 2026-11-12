"use client";

import { FolderGit2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, FieldLabel } from "@/components/ui";
import { useSettings, useUpdateSetting } from "@/lib/hooks";

interface Project {
  id: string;
  path: string;
}

/** Projects JARVIS may run checks in. Only the owner can register them; agents cannot. */
export function DevProjects() {
  const { data } = useSettings();
  const update = useUpdateSetting();
  const projects = ((data?.values as unknown as { dev_projects?: Project[] })?.dev_projects ?? []) as Project[];
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<unknown>(null);

  const save = async (next: Project[]) => {
    setError(null);
    try {
      await update("dev_projects", next);
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };

  return (
    <div className="space-y-3 text-xs">
      <p className="text-ink-3">
        Folders on the JARVIS server where the development agent may run predefined checks (tests, linters, type
        checks). Each run still needs your approval and gets no API keys.
      </p>
      <ul className="space-y-1.5">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded-lg border border-line bg-void/30 px-3 py-2">
            <FolderGit2 className="size-3.5 text-ink-3" aria-hidden />
            <span className="font-mono text-ice">{p.id}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3" title={p.path}>{p.path}</span>
            <Button
              variant="ghost"
              className="h-7 text-xs text-danger"
              icon={Trash2}
              aria-label={`Remove ${p.id}`}
              onClick={() => void save(projects.filter((x) => x.id !== p.id))}
            />
          </li>
        ))}
        {projects.length === 0 && <li className="text-ink-4">No projects registered.</li>}
      </ul>
      <form
        className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await save([...projects, { id: id.trim().toLowerCase(), path: path.trim() }])) {
            setId("");
            setPath("");
          }
        }}
      >
        <div>
          <FieldLabel htmlFor="proj-id">Id</FieldLabel>
          <input id="proj-id" className="field font-mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="my-app" />
        </div>
        <div>
          <FieldLabel htmlFor="proj-path">Absolute path</FieldLabel>
          <input id="proj-path" className="field font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/code/my-app" />
        </div>
        <Button type="submit" icon={Plus} disabled={!id.trim() || !path.trim()}>Add</Button>
      </form>
      <ErrorNote error={error} />
    </div>
  );
}
