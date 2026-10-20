import { useEffect, useId, useState } from "react";
import { useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { vercelRpcContract } from "./rpc.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Contract = typeof vercelRpcContract;
type Choices = PluginRpcResult<Contract["account.teams"]>["choices"];
export type ProjectChoice = {
  hostId: string;
  teamId: string;
  projectId: string;
  teamName: string;
  projectName: string;
};
type Listing =
  | { key: string; status: "ready"; choices: Choices }
  | { key: string; status: "loading" }
  | { key: string; status: "error" };

function ChoiceField({
  label,
  listing,
  value,
  placeholder,
  onChoose,
  onRetry,
}: {
  label: string;
  listing: Listing | null;
  value: string | null;
  placeholder: string;
  onChoose: (id: string) => void;
  onRetry: () => void;
}) {
  const id = useId();
  const lower = label.toLowerCase();
  const choices = listing?.status === "ready" ? listing.choices : [];
  const selected = choices.find((choice) => choice.id === value);
  const loading = listing?.status === "loading";
  const failed = listing?.status === "error";
  const empty = listing?.status === "ready" && choices.length === 0;
  const unavailable = loading || failed || empty || listing === null;
  const triggerLabel = loading
    ? `Loading ${lower}s…`
    : empty
      ? `No ${lower}s available`
      : (selected?.name ?? placeholder);
  return (
    <div className="flex flex-col gap-1.5">
      <Label id={id} className="block text-xs font-medium text-foreground">
        {label}
      </Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={unavailable}
            aria-labelledby={`${id} ${id}-value`}
            aria-busy={loading}
            className="w-full min-w-0 justify-between"
          >
            <span
              id={`${id}-value`}
              className={cn(
                "min-w-0 truncate",
                selected === undefined && "text-muted-foreground",
              )}
            >
              {triggerLabel}
            </span>
            <Icon
              name={loading ? "Spinner" : "ChevronDown"}
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground",
                loading && "animate-spin",
              )}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          mobileTitle={label}
          aria-labelledby={id}
          className="max-w-80"
        >
          {choices.map((choice) => (
            <DropdownMenuItem
              key={choice.id}
              role="menuitemradio"
              aria-checked={choice.id === value}
              onSelect={() => onChoose(choice.id)}
            >
              <span className="min-w-0 flex-1 truncate">{choice.name}</span>
              {choice.id === value ? (
                <Icon name="Check" className="size-3.5" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {failed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-destructive-text">
            Couldn't load {lower}s. Check that the machine is signed in with the
            Vercel CLI.
          </p>
          <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
            Retry {lower}s
          </Button>
        </div>
      ) : null}
      {empty ? (
        <p className="text-xs text-muted-foreground">
          No {lower}s are available for this selection.
        </p>
      ) : null}
    </div>
  );
}

export function ProjectFields({
  hostId,
  onChoose,
}: {
  hostId: string;
  onChoose: (choice: ProjectChoice | null) => void;
}) {
  const rpc = useRpc<Contract>();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [teamsAttempt, retryTeams] = useState(0);
  const [projectsAttempt, retryProjects] = useState(0);
  const [teams, setTeams] = useState<Listing>({
    key: hostId,
    status: "loading",
  });
  const projectKey = JSON.stringify([hostId, teamId]);
  const [projects, setProjects] = useState<Listing>({
    key: projectKey,
    status: "loading",
  });
  useEffect(() => {
    onChoose(null);
  }, [hostId, onChoose]);
  useEffect(() => {
    let current = true;
    setTeams({ key: hostId, status: "loading" });
    rpc.call("account.teams", { hostId }).then(
      (result) => {
        if (current)
          setTeams({ key: hostId, status: "ready", choices: result.choices });
      },
      () => {
        if (current) setTeams({ key: hostId, status: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, hostId, teamsAttempt]);
  useEffect(() => {
    if (teamId === null) return;
    let current = true;
    setProjects({ key: projectKey, status: "loading" });
    rpc.call("account.projects", { hostId, teamId }).then(
      (result) => {
        if (current)
          setProjects({
            key: projectKey,
            status: "ready",
            choices: result.choices,
          });
      },
      () => {
        if (current) setProjects({ key: projectKey, status: "error" });
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, hostId, teamId, projectKey, projectsAttempt]);
  const teamName =
    teams.status === "ready"
      ? teams.choices.find((choice) => choice.id === teamId)?.name
      : undefined;
  return (
    <>
      <ChoiceField
        label="Team"
        listing={teams}
        value={teamId}
        placeholder="Choose a team"
        onRetry={() => retryTeams((value) => value + 1)}
        onChoose={(next) => {
          setTeamId(next);
          setProjectId(null);
          onChoose(null);
        }}
      />
      <ChoiceField
        label="Project"
        listing={
          teamId === null
            ? null
            : projects.key === projectKey
              ? projects
              : { key: projectKey, status: "loading" }
        }
        value={projectId}
        placeholder={
          teamId === null ? "Choose a team first" : "Choose a project"
        }
        onRetry={() => retryProjects((value) => value + 1)}
        onChoose={(next) => {
          const projectName =
            projects.status === "ready"
              ? projects.choices.find((choice) => choice.id === next)?.name
              : undefined;
          setProjectId(next);
          if (
            teamId !== null &&
            teamName !== undefined &&
            projectName !== undefined
          )
            onChoose({
              hostId,
              teamId,
              projectId: next,
              teamName,
              projectName,
            });
        }}
      />
    </>
  );
}
