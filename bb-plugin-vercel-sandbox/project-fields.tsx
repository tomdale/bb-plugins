import { useEffect, useId, useState } from "react";
import { useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { vercelRpcContract } from "./rpc.js";
import { Button } from "@/components/ui/button";
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
};
type Listing =
  | { key: string; status: "ready"; choices: Choices }
  | { key: string; status: "loading" }
  | { key: string; status: "error" };

function ChoiceField({
  label,
  listing,
  value,
  onChoose,
  onRetry,
}: {
  label: string;
  listing: Listing;
  value: string | null;
  onChoose: (id: string) => void;
  onRetry: () => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label id={id} className="text-xs">
        {label}
      </Label>
      {listing.status === "loading" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading {label.toLowerCase()}s…
        </p>
      ) : listing.status === "error" ? (
        <div className="space-y-1">
          <p role="alert" className="text-xs text-destructive-text">
            Couldn't load {label.toLowerCase()}s. Check the machine's Vercel CLI
            login and connection.
          </p>
          <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
            Retry {label.toLowerCase()}s
          </Button>
        </div>
      ) : listing.choices.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No {label.toLowerCase()}s available for this selection.
        </p>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-labelledby={`${id} ${id}-value`}
              className="w-full min-w-0 justify-between sm:w-72"
            >
              <span id={`${id}-value`} className="truncate">
                {listing.choices.find((choice) => choice.id === value)?.name ??
                  `Choose a ${label.toLowerCase()}`}
              </span>
              <Icon name="ChevronDown" className="size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            mobileTitle={label}
            aria-labelledby={id}
            className="max-w-80"
          >
            {listing.choices.map((choice) => (
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
      )}
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
  return (
    <>
      <ChoiceField
        label="Team"
        listing={teams}
        value={teamId}
        onRetry={() => retryTeams((value) => value + 1)}
        onChoose={(next) => {
          setTeamId(next);
          setProjectId(null);
          onChoose(null);
        }}
      />
      {teamId === null ? null : (
        <ChoiceField
          label="Project"
          listing={
            projects.key === projectKey
              ? projects
              : { key: projectKey, status: "loading" }
          }
          value={projectId}
          onRetry={() => retryProjects((value) => value + 1)}
          onChoose={(next) => {
            setProjectId(next);
            onChoose({ hostId, teamId, projectId: next });
          }}
        />
      )}
    </>
  );
}
