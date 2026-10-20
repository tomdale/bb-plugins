import { useEffect, useId, useState, type ReactNode } from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Contract = typeof vercelRpcContract;
type Choices = PluginRpcResult<Contract["account.teams"]>["choices"];
export type ProjectChoice = {
  hostId: string;
  teamId: string;
  projectId: string;
  teamName: string;
  projectName: string;
};
/**
 * The team and project currently picked. `choice` is set only once both
 * listings confirm the picks, so a saved pick the account can no longer see
 * is never submitted.
 */
export type ProjectSelection = {
  teamId: string | null;
  projectId: string | null;
  choice: ProjectChoice | null;
};
type Listing =
  | { key: string; status: "ready"; choices: Choices }
  | { key: string; status: "loading" }
  | { key: string; status: "error" };

function ChoiceField({
  label,
  listing,
  value,
  knownName,
  placeholder,
  onChoose,
  onRetry,
}: {
  label: string;
  listing: Listing | null;
  value: string | null;
  /** The saved name for `value`, shown until the listing arrives. */
  knownName: string | null;
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
  // A saved pick keeps its name and stays openable while the list loads in
  // the background; only a field with nothing to show waits on a spinner.
  const waiting = loading && knownName === null;
  const unavailable = waiting || failed || empty || listing === null;
  const name = selected?.name ?? (loading ? knownName : null);
  const triggerLabel = waiting
    ? `Loading ${lower}s…`
    : empty
      ? `No ${lower}s available`
      : (name ?? placeholder);
  return (
    <FieldRow label={label} labelId={id}>
      <DropdownMenu>
        <IdTooltip id={value}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={unavailable}
              aria-labelledby={`${id} ${id}-value`}
              aria-busy={waiting}
              className={INLINE_TRIGGER_CLASS}
            >
              <span
                id={`${id}-value`}
                className={cn(
                  "min-w-0 truncate",
                  name === null && "text-muted-foreground",
                )}
              >
                {triggerLabel}
              </span>
              <Icon
                name={waiting ? "Spinner" : "ChevronDown"}
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground",
                  waiting && "animate-spin",
                )}
              />
            </Button>
          </DropdownMenuTrigger>
        </IdTooltip>
        <DropdownMenuContent
          align="start"
          mobileTitle={label}
          aria-labelledby={id}
          className="max-w-80"
        >
          {loading ? (
            <DropdownMenuItem disabled>
              <Icon name="Spinner" className="size-3.5 animate-spin" />
              Loading {lower}s…
            </DropdownMenuItem>
          ) : null}
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
    </FieldRow>
  );
}

/** Shows the picked Vercel ID when hovering or focusing a picker. */
function IdTooltip({
  id,
  children,
}: {
  id: string | null;
  children: ReactNode;
}) {
  if (id === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="font-mono">{id}</TooltipContent>
    </Tooltip>
  );
}

// The account grid. Pickers and read-only rows share one row height, and a
// trigger's outset equals its border plus padding, so picker text lines up
// with read-only values and the label column.
export const ROW_GRID_CLASS =
  "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm";
export const ROW_LABEL_CLASS = "flex h-8 items-center text-muted-foreground";
export const ROW_VALUE_CLASS = "flex min-h-8 min-w-0 flex-col justify-center";
export const INLINE_TRIGGER_CLASS =
  "-ml-[13px] w-[min(20rem,calc(100%+13px))] min-w-0 justify-between text-sm font-normal";

/**
 * One label/control row of the account grid, rendered as two grid cells so
 * pickers line up with read-only rows.
 */
export function FieldRow({
  label,
  labelId,
  children,
}: {
  label: string;
  labelId: string;
  children: ReactNode;
}) {
  return (
    <>
      <Label
        id={labelId}
        className={cn(ROW_LABEL_CLASS, "text-sm font-normal")}
      >
        {label}
      </Label>
      <div className={cn(ROW_VALUE_CLASS, "gap-1.5")}>{children}</div>
    </>
  );
}

/**
 * Team and project pickers for one machine. Both listings start loading on
 * mount, so a saved pick is ready to change by the time someone opens it.
 */
export function ProjectFields({
  hostId,
  initial,
  onChange,
}: {
  hostId: string;
  /** The saved team and project to preselect, with their display names. */
  initial: {
    teamId: string;
    projectId: string;
    teamName: string | null;
    projectName: string | null;
  } | null;
  onChange: (selection: ProjectSelection) => void;
}) {
  const rpc = useRpc<Contract>();
  const [teamId, setTeamId] = useState<string | null>(initial?.teamId ?? null);
  const [projectId, setProjectId] = useState<string | null>(
    initial?.projectId ?? null,
  );
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
  useEffect(() => {
    const team =
      teams.status === "ready"
        ? teams.choices.find((choice) => choice.id === teamId)
        : undefined;
    const project =
      projects.key === projectKey && projects.status === "ready"
        ? projects.choices.find((choice) => choice.id === projectId)
        : undefined;
    onChange({
      teamId,
      projectId,
      choice:
        team && project
          ? {
              hostId,
              teamId: team.id,
              projectId: project.id,
              teamName: team.name,
              projectName: project.name,
            }
          : null,
    });
  }, [hostId, teams, projects, projectKey, teamId, projectId, onChange]);
  const savedTeam = initial !== null && teamId === initial.teamId;
  return (
    <>
      <ChoiceField
        label="Team"
        listing={teams}
        value={teamId}
        knownName={savedTeam ? initial.teamName : null}
        placeholder="Choose a team"
        onRetry={() => retryTeams((value) => value + 1)}
        onChoose={(next) => {
          if (next === teamId) return;
          setTeamId(next);
          setProjectId(null);
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
        knownName={
          savedTeam && projectId === initial.projectId
            ? initial.projectName
            : null
        }
        placeholder={
          teamId === null ? "Choose a team first" : "Choose a project"
        }
        onRetry={() => retryProjects((value) => value + 1)}
        onChoose={setProjectId}
      />
    </>
  );
}
