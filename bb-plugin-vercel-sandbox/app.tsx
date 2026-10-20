import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  definePluginApp,
  useRpc,
  useSdk,
  type JsonValue,
  type PluginMachineProviderInputsChange,
  type PluginMachineProviderInputsProps,
  type PluginRpcResult,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  FieldRow,
  ProjectFields,
  type ProjectChoice,
} from "./project-fields.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "@/components/ui/option-display";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { vercelRpcContract } from "./rpc.js";
import { PROVIDER_ID } from "./provider-id.js";

type Contract = typeof vercelRpcContract;
type LaunchOptions = PluginRpcResult<Contract["launch.options"]>;
type AccountStatus = PluginRpcResult<Contract["account.inspect"]>;
type SavedAccount = PluginRpcResult<Contract["account.saved"]>;
type MachineStatus = PluginRpcResult<Contract["machine.inspect"]>["values"];

type LaunchInputs = { vcpus?: number; timeoutMinutes?: number };

type Load<T> =
  { status: "pending" } | { status: "ready"; data: T } | { status: "error" };

const TIMEOUT_LADDER_MINUTES = [15, 30, 45, 60, 120, 240, 480, 1440] as const;
const HOBBY_MAX_VCPUS = 4;
const PRO_MAX_VCPUS = 8;
const HOBBY_MAX_TIMEOUT_MINUTES = 45;
const WARNING_REMAINING_MS = 10 * 60_000;
const TICK_MS = 30_000;

const DATA_LOSS_NOTE =
  "The sandbox stops for good at its time limit. BB can't extend, pause, or restore it, so uncommitted files are lost. Push work you want to keep.";
const PLAN_NOTE =
  "Choices are Vercel maximums. BB can't see your plan; a launch above its limits fails when the sandbox starts.";

function isPlainObject(
  value: JsonValue | null,
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function readLaunchInputs(value: JsonValue | null): LaunchInputs | null {
  if (value === null) return {};
  if (!isPlainObject(value)) return null;
  const inputs: LaunchInputs = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "vcpus" && isWholeNumber(entry)) inputs.vcpus = entry;
    else if (key === "timeoutMinutes" && isWholeNumber(entry))
      inputs.timeoutMinutes = entry;
    else return null;
  }
  return inputs;
}

function launchInputsValue(inputs: LaunchInputs): JsonValue {
  return {
    ...(inputs.vcpus === undefined ? {} : { vcpus: inputs.vcpus }),
    ...(inputs.timeoutMinutes === undefined
      ? {}
      : { timeoutMinutes: inputs.timeoutMinutes }),
  };
}

function outOfRangeReason(
  inputs: LaunchInputs,
  limits: LaunchOptions["limits"],
): string | null {
  if (
    inputs.vcpus !== undefined &&
    !limits.allowedVcpus.includes(inputs.vcpus)
  ) {
    return `The saved choice of ${inputs.vcpus} vCPU isn't available. Vercel allows ${limits.allowedVcpus.join(", ")} vCPUs; choose another size.`;
  }
  if (
    inputs.timeoutMinutes !== undefined &&
    (inputs.timeoutMinutes < limits.minTimeoutMinutes ||
      inputs.timeoutMinutes > limits.maxTimeoutMinutes)
  ) {
    return `The saved time limit of ${formatMinutes(inputs.timeoutMinutes).full} is outside Vercel's ${formatMinutes(limits.minTimeoutMinutes).full}–${formatMinutes(limits.maxTimeoutMinutes).full} range. Choose another.`;
  }
  return null;
}

export function formatMinutes(minutes: number): {
  full: string;
  compact: string;
  spoken: string;
} {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const plural = (count: number, unit: string) =>
    `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (hours === 0) {
    return {
      full: `${minutes} min`,
      compact: `${minutes}m`,
      spoken: plural(minutes, "minute"),
    };
  }
  if (rest === 0) {
    return {
      full: `${hours} h`,
      compact: `${hours}h`,
      spoken: plural(hours, "hour"),
    };
  }
  return {
    full: `${hours} h ${rest} min`,
    compact: `${hours}h${rest}m`,
    spoken: `${plural(hours, "hour")} ${plural(rest, "minute")}`,
  };
}

function formatMemory(memoryMiB: number): string {
  const gib = memoryMiB / 1024;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

function sizeLabel(vcpus: number, memoryMiB: number): string {
  return `${vcpus} vCPU · ${formatMemory(memoryMiB)}`;
}

function isAllowedVcpuCount(vcpus: number): boolean {
  return vcpus === 1 || vcpus % 2 === 0;
}

function vcpuPlanTag(vcpus: number): string | null {
  if (vcpus <= HOBBY_MAX_VCPUS) return null;
  return vcpus <= PRO_MAX_VCPUS ? "Pro+" : "Enterprise";
}

function timeoutPlanTag(minutes: number): string | null {
  return minutes <= HOBBY_MAX_TIMEOUT_MINUTES ? null : "Pro+";
}

function choiceList(
  ladder: readonly number[],
  min: number,
  max: number,
  extra: readonly (number | undefined)[],
): number[] {
  const inRange = (candidate: number) => candidate >= min && candidate <= max;
  const values = new Set(ladder.filter(inRange));
  for (const candidate of extra) {
    if (candidate !== undefined && inRange(candidate)) values.add(candidate);
  }
  return [...values].sort((left, right) => left - right);
}

function useLoad<T>(request: () => Promise<T>): {
  state: Load<T>;
  retry: () => void;
  replace: (data: T) => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Load<T>>({ status: "pending" });
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    request().then(
      (data) => {
        if (generation.current === current) setState({ status: "ready", data });
      },
      () => {
        if (generation.current === current) setState({ status: "error" });
      },
    );
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [request, attempt]);
  const retry = useCallback(() => {
    setState({ status: "pending" });
    setAttempt((current) => current + 1);
  }, []);
  const replace = useCallback((data: T) => {
    generation.current += 1;
    setState({ status: "ready", data });
  }, []);
  return { state, retry, replace };
}

function useLaunchOptions() {
  const rpc = useRpc<Contract>();
  const request = useCallback(() => rpc.call("launch.options", {}), [rpc]);
  return useLoad(request);
}

function MenuChoice({
  label,
  tag,
  selected,
  onSelect,
}: {
  label: string;
  tag: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={selected}
      onSelect={onSelect}
      className="flex items-center justify-between gap-3"
    >
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {tag === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>
      )}
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          "shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}

function MenuNote({
  id,
  tone,
  children,
}: {
  id?: string;
  tone: "muted" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "flex max-w-72 gap-2 px-2 py-1.5 text-xs leading-relaxed",
        tone === "warning" ? "text-warning-text" : "text-muted-foreground",
      )}
    >
      <Icon
        name={tone === "warning" ? "AlertTriangle" : "Info"}
        className={cn(
          "mt-0.5 shrink-0",
          COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
        )}
      />
      <span className="min-w-0 whitespace-normal">{children}</span>
    </div>
  );
}

function optionsErrorMessage(
  inputs: LaunchInputs | null,
  blocked: boolean,
): string {
  const prefix = "Couldn't load Vercel launch options.";
  if (inputs === null || blocked) {
    return `${prefix} Retry, then choose new options.`;
  }
  const parts = [
    ...(inputs.vcpus === undefined ? [] : [`${inputs.vcpus} vCPU`]),
    ...(inputs.timeoutMinutes === undefined
      ? []
      : [`stops after ${formatMinutes(inputs.timeoutMinutes).full}`]),
  ];
  if (parts.length === 0) {
    return `${prefix} New sandboxes use the defaults in plugin settings.`;
  }
  const rest = parts.length === 2 ? "" : ", with plugin defaults for the rest";
  return `${prefix} This thread uses your saved choice (${parts.join(", ")})${rest}. Retry to change it.`;
}

function launchChange(
  inputs: LaunchInputs | null,
  options: Load<LaunchOptions>,
): PluginMachineProviderInputsChange {
  if (inputs === null) {
    return {
      status: "blocked",
      reason:
        "The saved Vercel sandbox options are invalid. Choose new ones from the sandbox menu.",
    };
  }
  if (inputs.vcpus !== undefined && !isAllowedVcpuCount(inputs.vcpus)) {
    return {
      status: "blocked",
      reason: `The saved choice of ${inputs.vcpus} vCPU isn't available. Vercel accepts 1 or an even number of vCPUs; choose another size.`,
    };
  }
  if (options.status === "ready") {
    const reason = outOfRangeReason(inputs, options.data.limits);
    if (reason !== null) return { status: "blocked", reason };
  }
  return { status: "ready", value: launchInputsValue(inputs) };
}

function VercelMachineInputsControl({
  value,
  onChange,
}: PluginMachineProviderInputsProps) {
  const { state: options, retry } = useLaunchOptions();
  const noteIdPrefix = useId();
  const blockedNoteId = `${noteIdPrefix}-blocked`;
  const dataLossNoteId = `${noteIdPrefix}-data-loss`;
  const planNoteId = `${noteIdPrefix}-plan`;
  const inputs = readLaunchInputs(value);
  const change = launchChange(inputs, options);
  useEffect(() => {
    onChange(launchChange(readLaunchInputs(value), options));
  }, [value, options, onChange]);

  const blockedReason = change.status === "blocked" ? change.reason : null;
  const loaded = options.status === "ready" ? options.data : null;
  const valid = inputs !== null && blockedReason === null ? inputs : {};
  const vcpus = valid.vcpus ?? loaded?.defaultInputs.vcpus;
  const timeoutMinutes =
    valid.timeoutMinutes ?? loaded?.defaultInputs.timeoutMinutes;

  const choose = (next: LaunchInputs) => {
    const merged = {
      vcpus: next.vcpus ?? vcpus,
      timeoutMinutes: next.timeoutMinutes ?? timeoutMinutes,
    };
    onChange({ status: "ready", value: launchInputsValue(merged) });
  };

  let fullLabel: string;
  let compactLabel: string;
  let accessibleLabel: string;
  if (blockedReason !== null) {
    fullLabel = "Choose sandbox size";
    compactLabel = "Choose size";
    accessibleLabel = "Vercel sandbox: choose new options";
  } else if (vcpus !== undefined && timeoutMinutes !== undefined) {
    const duration = formatMinutes(timeoutMinutes);
    fullLabel = `${vcpus} vCPU · ${duration.full}`;
    compactLabel = `${vcpus} · ${duration.compact}`;
    accessibleLabel = `Vercel sandbox: ${vcpus} vCPU, stops after ${duration.spoken}`;
  } else {
    fullLabel = "Vercel sandbox";
    compactLabel = "Vercel";
    accessibleLabel =
      options.status === "error"
        ? "Vercel sandbox: options unavailable"
        : "Vercel sandbox: loading options";
  }
  const showAlert = blockedReason !== null || options.status === "error";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={accessibleLabel}
          data-promptbox-shrinkable-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            showAlert ? "text-warning-text" : OPTION_MUTED_CLASS_NAME,
          )}
        >
          {showAlert ? (
            <Icon
              name="AlertTriangle"
              className={cn("shrink-0", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
            />
          ) : options.status === "pending" && vcpus === undefined ? (
            <Icon
              name="Spinner"
              className={cn(
                "shrink-0 animate-spin",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
          ) : null}
          <span className="min-w-0 truncate" data-promptbox-full-label="">
            {fullLabel}
          </span>
          <span className="min-w-0 truncate" data-promptbox-compact-label="">
            {compactLabel}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "shrink-0 text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Vercel sandbox"
        aria-describedby={[
          ...(blockedReason === null ? [] : [blockedNoteId]),
          dataLossNoteId,
          planNoteId,
        ].join(" ")}
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-80")}
      >
        {blockedReason === null ? null : (
          <MenuNote id={blockedNoteId} tone="warning">
            {blockedReason}
          </MenuNote>
        )}
        {options.status === "pending" ? (
          <p
            role="status"
            className="px-2 py-1.5 text-xs text-muted-foreground"
          >
            Loading Vercel launch options…
          </p>
        ) : null}
        {options.status === "error" ? (
          <>
            <p
              role="alert"
              className="max-w-72 whitespace-normal px-2 py-1.5 text-xs text-warning-text"
            >
              {optionsErrorMessage(inputs, blockedReason !== null)}
            </p>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                retry();
              }}
              className="text-xs"
            >
              <Icon name="ArrowReloadHorizontal" className="size-3.5" />
              Retry
            </DropdownMenuItem>
          </>
        ) : null}
        {loaded === null ? null : (
          <>
            <DropdownMenuGroup aria-label="vCPU">
              <DropdownMenuLabel>vCPU</DropdownMenuLabel>
              {loaded.limits.allowedVcpus.map((candidate) => (
                <MenuChoice
                  key={candidate}
                  label={`${sizeLabel(candidate, candidate * loaded.memoryMiBPerVcpu)}${candidate === loaded.defaultInputs.vcpus ? " (default)" : ""}`}
                  tag={vcpuPlanTag(candidate)}
                  selected={blockedReason === null && candidate === vcpus}
                  onSelect={() => choose({ vcpus: candidate })}
                />
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-label="Stops after">
              <DropdownMenuLabel>Stops after</DropdownMenuLabel>
              {choiceList(
                TIMEOUT_LADDER_MINUTES,
                loaded.limits.minTimeoutMinutes,
                loaded.limits.maxTimeoutMinutes,
                [loaded.defaultInputs.timeoutMinutes, inputs?.timeoutMinutes],
              ).map((candidate) => (
                <MenuChoice
                  key={candidate}
                  label={`${formatMinutes(candidate).full}${candidate === loaded.defaultInputs.timeoutMinutes ? " (default)" : ""}`}
                  tag={timeoutPlanTag(candidate)}
                  selected={
                    blockedReason === null && candidate === timeoutMinutes
                  }
                  onSelect={() => choose({ timeoutMinutes: candidate })}
                />
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <MenuNote id={dataLossNoteId} tone="warning">
          {DATA_LOSS_NOTE}
        </MenuNote>
        <MenuNote id={planNoteId} tone="muted">
          {PLAN_NOTE}
        </MenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettingsHeading({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {action}
    </div>
  );
}

type AccountHost = { id: string; name: string; online: boolean };

type ConnectState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "failed"; reason: string | null };

const MIN_VC_VERSION = "58.3.0";
const CONNECT_FAILED_MESSAGE =
  "Couldn't connect. Check that the machine is online and that vc login finished there as the OS user that runs BB, then try again.";
const TOKEN_SHAPED = /eyJ[\w-]{8,}|\bvca_|\bbearer\s|token\s*[=:]/i;

function serverReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (Reflect.get(error, "code") !== "handler_error") return null;
  const message = error.message.trim();
  if (
    message === "" ||
    message.length > 500 ||
    /[\r\n]/.test(message) ||
    TOKEN_SHAPED.test(message)
  ) {
    return null;
  }
  return message;
}

function accountLabel(accountName: string | null, accountId: string): string {
  return accountName === null ? accountId : `${accountName} (${accountId})`;
}

function FailureReason({ reason }: { reason: string | null }) {
  if (reason === null) return null;
  return (
    <span className="block break-words text-muted-foreground">{reason}</span>
  );
}

function useAccountHosts() {
  const sdk = useSdk();
  const request = useCallback(async (): Promise<AccountHost[]> => {
    const hosts = await sdk.hosts.list({ type: "persistent" });
    return hosts
      .filter(
        (host) =>
          host.machineProviderId === null &&
          host.lifecycle.phase !== "removing" &&
          host.lifecycle.phase !== "destroyed",
      )
      .map((host) => ({
        id: host.id,
        name: host.name,
        online: host.status === "connected",
      }));
  }, [sdk]);
  return useLoad(request);
}

function hostLabel(hosts: Load<AccountHost[]>, hostId: string): string {
  const host =
    hosts.status === "ready"
      ? hosts.data.find((candidate) => candidate.id === hostId)
      : undefined;
  return host?.name ?? hostId;
}

// Label and value columns shared by the read-only connection rows and the
// inline editor, so editing swaps values for controls in place.
const CONNECTION_GRID = "grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 text-sm";

/** A display name whose underlying Vercel ID appears on hover or focus. */
function NamedId({ name, id }: { name: string | null; id: string }) {
  if (name === null) return <span className="break-all font-mono">{id}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {name}
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono">{id}</TooltipContent>
    </Tooltip>
  );
}

function ConnectionDetails({
  account,
  machineName,
}: {
  account: SavedAccount;
  machineName: string;
}) {
  const rows: { term: string; value: ReactNode }[] = [
    { term: "Machine", value: machineName },
  ];
  if (account.teamId !== null)
    rows.push({
      term: "Team",
      value: <NamedId name={account.teamName} id={account.teamId} />,
    });
  if (account.projectId !== null)
    rows.push({
      term: "Project",
      value: <NamedId name={account.projectName} id={account.projectId} />,
    });
  if (account.accountId !== null)
    rows.push({
      term: "Signed in as",
      value: <NamedId name={account.accountName} id={account.accountId} />,
    });
  if (account.directory !== null)
    rows.push({
      term: "Linked folder",
      value: <span className="break-all font-mono">{account.directory}</span>,
    });
  return (
    <dl className={cn(CONNECTION_GRID, "gap-y-1.5")}>
      {rows.map(({ term, value }) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The one-line connection state above the details. Checking and connected
 * share the same single-line shape so a finished check doesn't move the page.
 */
function ConnectionStatus({
  state,
  known,
  hosts,
}: {
  state: Load<AccountStatus>;
  /** The saved or last-checked connection, shown while a check runs. */
  known: SavedAccount | null;
  hosts: Load<AccountHost[]>;
}) {
  const line = "flex min-h-5 items-start gap-2 text-sm";
  const icon = "mt-[3px] size-3.5 shrink-0";
  if (state.status === "pending") {
    return (
      <p role="status" className={cn(line, "text-muted-foreground")}>
        <Icon name="Spinner" className={cn(icon, "animate-spin")} />
        {known?.hostId
          ? `Checking the Vercel CLI on ${hostLabel(hosts, known.hostId)}…`
          : "Checking the Vercel connection…"}
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className={cn(line, "text-destructive-text")}>
        <Icon name="AlertCircle" className={icon} />
        Couldn't check the Vercel connection. Try again in a moment.
      </p>
    );
  }
  const account = state.data;
  if (account.hostId === null) {
    return (
      <div role="status" className="space-y-1">
        <p className={cn(line, "text-foreground")}>
          <Icon name="Info" className={icon} />
          <span className="min-w-0 break-words">
            Not connected. Sign in with the Vercel CLI on one of your machines,
            then choose where sandboxes are created.
          </span>
        </p>
        {account.message === "" ? null : (
          <p className="pl-5.5 text-xs leading-relaxed text-muted-foreground">
            {account.message}
          </p>
        )}
      </div>
    );
  }
  if (!account.available) {
    return (
      <div role="alert" className="space-y-1">
        <p className={cn(line, "text-destructive-text")}>
          <Icon name="AlertCircle" className={icon} />
          <span className="min-w-0 break-words">{account.message}</span>
        </p>
        <p className="pl-5.5 text-xs leading-relaxed text-muted-foreground">
          BB can't start or manage sandboxes with this account. Fix it on{" "}
          {hostLabel(hosts, account.hostId)} and check again, or edit the
          account.
        </p>
      </div>
    );
  }
  return (
    <p role="status" className={cn(line, "text-foreground")}>
      <Icon name="CircleCheck" className={cn(icon, "text-success")} />
      <span className="min-w-0 break-words">
        Connected. New sandboxes are created with this account.
      </span>
    </p>
  );
}

function MachineField({
  labelId,
  describedById,
  triggerRef,
  hosts,
  hostId,
  onRetry,
  onChoose,
}: {
  labelId: string;
  describedById: string | undefined;
  triggerRef: RefObject<HTMLButtonElement | null>;
  hosts: Load<AccountHost[]>;
  hostId: string | null;
  onRetry: () => void;
  onChoose: (hostId: string) => void;
}) {
  if (hosts.status === "pending") {
    return (
      <p
        role="status"
        className="flex h-8 items-center text-xs text-muted-foreground"
      >
        Loading your machines…
      </p>
    );
  }
  if (hosts.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-xs text-destructive-text">
          Couldn't load your machines.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (hosts.data.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-muted-foreground">
          No machines are enrolled in BB. Add the machine that runs the Vercel
          CLI, then check again.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
          Check again
        </Button>
      </div>
    );
  }
  const selected = hosts.data.find((host) => host.id === hostId) ?? null;
  const triggerLabel =
    selected === null
      ? "Choose a machine"
      : `${selected.name}${selected.online ? "" : " (offline)"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="sm"
          aria-labelledby={`${labelId} ${labelId}-value`}
          aria-describedby={describedById}
          className="w-full min-w-0 justify-between"
        >
          <span id={`${labelId}-value`} className="min-w-0 truncate">
            {triggerLabel}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "shrink-0 text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Machine"
        aria-labelledby={labelId}
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-80")}
      >
        {hosts.data.map((host) => (
          <MenuChoice
            key={host.id}
            label={host.name}
            tag={host.online ? null : "Offline"}
            selected={host.id === hostId}
            onSelect={() => onChoose(host.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Chooses the machine, team, and project for new sandboxes. In setup it
 * explains the CLI sign-in first; in edit it replaces the read-only rows in
 * place, preselected with the saved connection.
 */
function ConnectForm({
  account,
  mode,
  hosts,
  retryHosts,
  onConnected,
  onCancel,
  reinspect,
}: {
  account: SavedAccount | null;
  mode: "setup" | "edit";
  hosts: Load<AccountHost[]>;
  retryHosts: () => void;
  onConnected: (account: AccountStatus) => void;
  onCancel: () => void;
  reinspect: () => void;
}) {
  const rpc = useRpc<Contract>();
  const idPrefix = useId();
  const machineLabelId = `${idPrefix}-machine`;
  const hostProblemId = `${idPrefix}-machine-problem`;
  const machineTriggerRef = useRef<HTMLButtonElement>(null);
  const [hostChoice, setHostChoice] = useState<string | null>(null);
  const [projectChoice, setProjectChoice] = useState<ProjectChoice | null>(
    null,
  );
  const chooseProject = useCallback((choice: ProjectChoice | null) => {
    setProjectChoice(choice);
    setConnect({ status: "idle" });
  }, []);
  const [attempted, setAttempted] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{
    target: "machine";
    attempt: number;
  } | null>(null);
  useEffect(() => {
    if (focusRequest === null) return;
    machineTriggerRef.current?.focus();
  }, [focusRequest]);
  const [connect, setConnect] = useState<ConnectState>({ status: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const hostList = hosts.status === "ready" ? hosts.data : [];
  const onlyHost = hostList.length === 1 ? hostList[0] : undefined;
  const hostId = hostChoice ?? account?.hostId ?? onlyHost?.id ?? null;
  const selectedHost = hostList.find((host) => host.id === hostId) ?? null;
  const scope = projectChoice?.hostId === hostId ? projectChoice : null;
  const hostProblem =
    selectedHost === null
      ? attempted && hosts.status === "ready" && hostList.length > 0
        ? "Choose the machine where you ran vc login."
        : null
      : selectedHost.online
        ? null
        : `${selectedHost.name} is offline. Reconnect it to BB before connecting Vercel.`;
  const connecting = connect.status === "connecting";
  const editing = mode === "edit";
  const initialScope =
    account !== null &&
    account.hostId === hostId &&
    account.teamId !== null &&
    account.projectId !== null
      ? { teamId: account.teamId, projectId: account.projectId }
      : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (connecting) return;
    if (selectedHost === null || !selectedHost.online) {
      setFocusRequest((previous) => ({
        target: "machine",
        attempt: (previous?.attempt ?? 0) + 1,
      }));
      return;
    }
    if (scope === null) return;
    setHostChoice(selectedHost.id);
    setConnect({ status: "connecting" });
    rpc
      .call("account.connect", {
        hostId: scope.hostId,
        teamId: scope.teamId,
        projectId: scope.projectId,
        teamName: scope.teamName,
        projectName: scope.projectName,
        adoptLegacyAllocations: false,
        expectedLegacyIdentity: null,
      })
      .then(
        (result) => {
          if (!mounted.current) return;
          setConnect({ status: "idle" });
          onConnected(result);
        },
        (error: unknown) => {
          if (!mounted.current) return;
          setConnect({ status: "failed", reason: serverReason(error) });
          reinspect();
        },
      );
  };

  return (
    <form
      noValidate
      aria-label={
        editing ? "Edit the Vercel account" : "Connect the Vercel CLI"
      }
      onSubmit={submit}
      className="space-y-4"
    >
      {editing ? null : (
        <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>
            On the machine BB should use, open a terminal as the same OS user
            that runs BB there. Check that the Vercel CLI is {MIN_VC_VERSION} or
            later (
            <code className="font-mono text-foreground">vc --version</code>
            ), then run{" "}
            <code className="font-mono text-foreground">vc login</code> and
            finish Vercel's sign-in in your browser.
          </li>
          <li>
            Choose that machine, then select the Vercel team and project to use
            for sandboxes.
          </li>
        </ol>
      )}

      <fieldset
        disabled={connecting}
        className={cn(CONNECTION_GRID, "max-w-lg items-start gap-y-2")}
      >
        <FieldRow label="Machine" labelId={machineLabelId}>
          <MachineField
            labelId={machineLabelId}
            describedById={hostProblem === null ? undefined : hostProblemId}
            triggerRef={machineTriggerRef}
            hosts={hosts}
            hostId={hostId}
            onRetry={retryHosts}
            onChoose={(next) => {
              setHostChoice(next);
              setProjectChoice(null);
              setConnect({ status: "idle" });
            }}
          />
          {hostProblem === null ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <p id={hostProblemId} className="text-xs text-warning-text">
                {hostProblem}
              </p>
              {selectedHost !== null && !selectedHost.online ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={retryHosts}
                >
                  Check again
                </Button>
              ) : null}
            </div>
          )}
        </FieldRow>

        {hostId !== null && selectedHost?.online ? (
          <ProjectFields
            key={hostId}
            hostId={hostId}
            initial={initialScope}
            onChoose={chooseProject}
          />
        ) : null}
      </fieldset>

      {editing ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Changes apply to new sandboxes; existing sandboxes keep the account
          they started with. To use a different Vercel user, run{" "}
          <code className="font-mono text-foreground">vc login</code> on the
          machine first.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={connecting || scope === null}
          aria-busy={connecting}
        >
          {connecting ? (
            <Icon name="Spinner" className="size-3.5 animate-spin" />
          ) : null}
          {connecting
            ? editing
              ? "Saving…"
              : "Connecting…"
            : editing
              ? "Save"
              : "Connect"}
        </Button>
        {editing ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={connecting}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
        {scope === null && hostId !== null && selectedHost?.online ? (
          <p className="text-xs text-muted-foreground">
            Choose a team and project first.
          </p>
        ) : null}
        {connect.status === "failed" ? (
          <p role="alert" className="text-xs text-destructive-text">
            {CONNECT_FAILED_MESSAGE}
            <FailureReason reason={connect.reason} />
          </p>
        ) : null}
      </div>

      {editing ? null : (
        <div className="max-w-prose space-y-1 text-xs leading-relaxed text-muted-foreground">
          <p>
            Your Vercel sign-in stays in the CLI on that machine. BB saves only
            the machine and the account, team, and project IDs, and asks the CLI
            for a short-lived token each time.
          </p>
          <p>
            This page can't remove an access token saved by an earlier version
            of this plugin; revoke that token in Vercel if you no longer use it.
          </p>
        </div>
      )}
    </form>
  );
}

type AdoptState =
  | { status: "idle" }
  | { status: "adopting"; identity: string }
  | { status: "failed"; identity: string; reason: string | null }
  | { status: "adopted"; identity: string; count: number; account: string };

function pluralSandboxes(count: number): string {
  return `${count} earlier sandbox${count === 1 ? "" : "es"}`;
}

function connectionIdentity(account: AccountStatus): string {
  return JSON.stringify([
    account.hostId,
    account.directory,
    account.accountId,
    account.teamId,
    account.projectId,
  ]);
}

function AdoptedNote({ count, account }: { count: number; account: string }) {
  return (
    <p role="status" className="flex items-start gap-2 text-xs text-foreground">
      <Icon
        name="CircleCheck"
        className="mt-0.5 size-3.5 shrink-0 text-success"
      />
      <span className="min-w-0 break-words">
        BB now manages {pluralSandboxes(count)} with {account}.
      </span>
    </p>
  );
}

function PartialAdoptionAlert({ reason }: { reason: string | null }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 text-xs text-destructive-text"
    >
      <Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        Couldn't finish updating the earlier sandboxes. Some may already use
        this account; BB rechecks which still need one before you try again.
        <FailureReason reason={reason} />
      </span>
    </p>
  );
}

function LegacyAllocations({
  state,
  hosts,
  onConnected,
  reinspect,
}: {
  state: Load<AccountStatus>;
  hosts: Load<AccountHost[]>;
  onConnected: (account: AccountStatus) => void;
  reinspect: () => void;
}) {
  const rpc = useRpc<Contract>();
  const consentId = useId();
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [adoptState, setAdopt] = useState<AdoptState>({ status: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const account = state.status === "ready" ? state.data : null;
  const identity = account === null ? null : connectionIdentity(account);
  const adopt: AdoptState =
    adoptState.status === "idle" ||
    identity === null ||
    adoptState.identity === identity
      ? adoptState
      : { status: "idle" };
  const legacy = account?.legacyAllocations ?? null;
  const remaining = legacy !== null && legacy.count > 0 ? legacy : null;

  if (account === null || remaining === null) {
    if (adopt.status === "adopted") {
      return (
        <section className="space-y-2">
          <SettingsHeading title="Earlier sandboxes" />
          <AdoptedNote count={adopt.count} account={adopt.account} />
        </section>
      );
    }
    if (adopt.status !== "failed") return null;
    return (
      <section className="space-y-2">
        <SettingsHeading title="Earlier sandboxes" />
        <PartialAdoptionAlert reason={adopt.reason} />
        {state.status === "pending" ? (
          <p role="status" className="text-xs text-muted-foreground">
            Checking which earlier sandboxes still need an account…
          </p>
        ) : state.status === "error" ? (
          <p role="alert" className="text-xs text-destructive-text">
            Couldn't check which earlier sandboxes still need an account. Check
            again before retrying.
          </p>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            No earlier sandboxes still need an account.
          </p>
        )}
      </section>
    );
  }

  const { hostId, directory, accountId } = account;
  const machineName = hostId === null ? "" : hostLabel(hosts, hostId);
  const who =
    accountId === null
      ? "the signed-in Vercel account"
      : accountLabel(account.accountName, accountId);
  const offerKey = JSON.stringify([identity, remaining]);
  const consent = consentFor === offerKey;
  const canAdopt =
    account.available &&
    hostId !== null &&
    account.teamId !== null &&
    account.projectId !== null &&
    accountId !== null &&
    adopt.status !== "adopting";
  const submit = () => {
    if (!canAdopt || !consent || identity === null) return;
    setAdopt({ status: "adopting", identity });
    rpc
      .call("account.connect", {
        hostId,
        ...(directory !== null
          ? { directory }
          : { teamId: account.teamId!, projectId: account.projectId! }),
        adoptLegacyAllocations: true,
        expectedLegacyIdentity: {
          accountId,
          teamId: remaining.teamId,
          projectId: remaining.projectId,
          count: remaining.count,
        },
      })
      .then(
        (result) => {
          if (!mounted.current) return;
          setConsentFor(null);
          setAdopt({
            status: "adopted",
            identity: connectionIdentity(result),
            count: result.adoptedAllocations,
            account:
              result.accountId === null
                ? who
                : accountLabel(result.accountName, result.accountId),
          });
          onConnected(result);
        },
        (error: unknown) => {
          if (!mounted.current) return;
          setConsentFor(null);
          setAdopt({ status: "failed", identity, reason: serverReason(error) });
          reinspect();
        },
      );
  };
  return (
    <section className="space-y-2">
      <SettingsHeading title="Earlier sandboxes" />
      {adopt.status === "failed" ? (
        <PartialAdoptionAlert reason={adopt.reason} />
      ) : null}
      <p className="text-xs leading-relaxed text-foreground">
        BB recorded {pluralSandboxes(remaining.count)} in{" "}
        <span className="font-mono">
          {remaining.teamId} / {remaining.projectId}
        </span>{" "}
        before it tracked which Vercel account created them. BB won't manage or
        clean them up until you choose an account for them.
      </p>
      {account.available ? null : (
        <p className="text-xs text-warning-text">
          Fix the connection above before choosing an account for them.
        </p>
      )}
      <div className="flex items-start gap-2">
        <Checkbox
          id={consentId}
          checked={consent}
          disabled={!canAdopt}
          aria-describedby={`${consentId}-note`}
          onCheckedChange={(checked) =>
            setConsentFor(checked === true ? offerKey : null)
          }
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor={consentId} className="text-xs leading-relaxed">
            Let {who} on {machineName} manage and clean up these{" "}
            {pluralSandboxes(remaining.count)}
          </Label>
          <p
            id={`${consentId}-note`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            This is your authorization, not a record of who created them. BB
            can't check that from its old records. BB refuses the change if the
            CLI's account, project, or the number of sandboxes no longer
            matches. Once set, reconnecting doesn't change it.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canAdopt || !consent}
          aria-busy={adopt.status === "adopting"}
          onClick={submit}
        >
          {adopt.status === "adopting" ? (
            <Icon name="Spinner" className="size-3.5 animate-spin" />
          ) : null}
          {adopt.status === "adopting"
            ? "Saving…"
            : `Use this account for ${pluralSandboxes(remaining.count)}`}
        </Button>
        {adopt.status === "adopted" ? (
          <AdoptedNote count={adopt.count} account={adopt.account} />
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        If these sandboxes were created with an access token saved by an earlier
        version of this plugin, this page can't remove that token. Revoke it in
        Vercel once you no longer need it.
      </p>
    </section>
  );
}

function VercelSettingsSection() {
  const rpc = useRpc<Contract>();
  const inspectAccount = useCallback(
    () => rpc.call("account.inspect", {}),
    [rpc],
  );
  const account = useLoad(inspectAccount);
  // The saved connection loads without contacting the authentication
  // machine, so the page can show it while the slower check runs.
  const readSaved = useCallback(() => rpc.call("account.saved", {}), [rpc]);
  const saved = useLoad(readSaved);
  const hosts = useAccountHosts();
  const { state: options, retry: retryOptions } = useLaunchOptions();
  const loaded = options.status === "ready" ? options.data : null;
  const [editing, setEditing] = useState(false);
  const checkAgain = () => {
    account.retry();
    hosts.retry();
  };
  const latest = account.state.status === "ready" ? account.state.data : null;
  const [lastKnown, setLastKnown] = useState<AccountStatus | null>(null);
  useEffect(() => {
    if (latest !== null) setLastKnown(latest);
  }, [latest]);
  const current = latest ?? lastKnown;
  const known: SavedAccount | null =
    current ?? (saved.state.status === "ready" ? saved.state.data : null);
  const checking = account.state.status === "pending";
  // Setup replaces the details only once the saved or checked connection
  // shows there is none, so a pending check never flashes the setup form.
  const setup = known !== null && known.hostId === null;
  // Check again is offered only after a check fails: a healthy or empty
  // connection is already rechecked on every visit. It stays visible while
  // its own recheck runs.
  const failed =
    account.state.status === "error" ||
    (latest !== null && latest.hostId !== null && !latest.available);
  const [recheckable, setRecheckable] = useState(false);
  useEffect(() => {
    if (!checking) setRecheckable(failed);
  }, [checking, failed]);
  const connectionLoaded = (next: AccountStatus) => {
    account.replace(next);
    setEditing(false);
  };
  return (
    <TooltipProvider delayDuration={300}>
      <div className="w-full min-w-0 space-y-6">
        <section className="space-y-3">
          <SettingsHeading
            title="Account"
            action={
              <div className="flex items-center gap-2">
                {recheckable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={checking}
                    onClick={checkAgain}
                  >
                    {checking ? (
                      <Icon name="Spinner" className="size-3.5 animate-spin" />
                    ) : null}
                    Check again
                  </Button>
                ) : null}
                {known?.hostId && !editing ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </Button>
                ) : null}
              </div>
            }
          />
          <ConnectionStatus
            state={account.state}
            known={known}
            hosts={hosts.state}
          />
          {setup || editing ? (
            <ConnectForm
              account={known}
              mode={editing ? "edit" : "setup"}
              hosts={hosts.state}
              retryHosts={hosts.retry}
              onConnected={connectionLoaded}
              onCancel={() => setEditing(false)}
              reinspect={account.retry}
            />
          ) : known?.hostId ? (
            <ConnectionDetails
              account={known}
              machineName={hostLabel(hosts.state, known.hostId)}
            />
          ) : null}
        </section>

        <LegacyAllocations
          state={account.state}
          hosts={hosts.state}
          onConnected={connectionLoaded}
          reinspect={account.retry}
        />

        <section className="space-y-3 border-t border-border pt-5">
          <SettingsHeading title="New sandboxes" />
          {options.status === "pending" ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading launch defaults…
            </p>
          ) : null}
          {options.status === "error" ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-xs text-destructive-text">
                Couldn't load launch defaults.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={retryOptions}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {loaded === null ? null : (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Default size</dt>
              <dd className="text-foreground">
                {sizeLabel(
                  loaded.defaultInputs.vcpus,
                  loaded.defaultInputs.vcpus * loaded.memoryMiBPerVcpu,
                )}
              </dd>
              <dt className="text-muted-foreground">Stops after</dt>
              <dd className="text-foreground">
                {formatMinutes(loaded.defaultInputs.timeoutMinutes).full}
              </dd>
              <dt className="text-muted-foreground">Limits</dt>
              <dd className="text-foreground">
                {loaded.limits.minVcpus}–{loaded.limits.maxVcpus} vCPU,{" "}
                {formatMinutes(loaded.limits.minTimeoutMinutes).full}–
                {formatMinutes(loaded.limits.maxTimeoutMinutes).full}
              </dd>
              <dt className="text-muted-foreground">Image</dt>
              <dd className="min-w-0 break-all font-mono text-foreground">
                {loaded.image}
              </dd>
            </dl>
          )}
          <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            Your Vercel plan may set lower limits. Change the defaults with
            Default vCPUs and Default lifetime above; the composer can override
            them per thread.
          </p>
        </section>

        <section className="space-y-3 border-t border-border pt-5">
          <SettingsHeading title="Data and billing" />
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            <li>
              Each sandbox is a disposable BB machine. It stops for good at its
              time limit; BB can't extend, pause, snapshot, or restore it.
            </li>
            <li>
              Uncommitted files are lost when the sandbox stops, when its
              machine is removed, or when its thread is archived. Push work you
              want to keep.
            </li>
            <li>
              Vercel bills your team while a sandbox runs, whether or not the
              agent is working. Remove machines you're done with.
            </li>
          </ul>
        </section>
      </div>
    </TooltipProvider>
  );
}

type HostResolution =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "retrying"; failures: number }
  | { kind: "creating"; hostId: string }
  | { kind: "removing"; hostId: string }
  | { kind: "cleanup-failed"; hostId: string }
  | { kind: "removed"; hostId: string }
  | { kind: "active"; hostId: string };

type ResolvedHost = Exclude<
  HostResolution,
  { kind: "pending" } | { kind: "retrying" }
>;

function lookupRetryDelay(failures: number): number {
  return Math.min(LOOKUP_RETRY_MAX_MS, TICK_MS * 2 ** (failures - 1));
}

function useVercelHost(threadId: string, refreshKey: number): HostResolution {
  const sdk = useSdk();
  const [resolution, setResolution] = useState<{
    threadId: string;
    value: HostResolution;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const current: HostResolution =
    resolution?.threadId === threadId ? resolution.value : { kind: "pending" };
  const settled = current.kind === "none" || current.kind === "removed";
  const pollDelay =
    current.kind === "waiting" ||
    current.kind === "creating" ||
    current.kind === "removing"
      ? TICK_MS
      : current.kind === "retrying"
        ? lookupRetryDelay(current.failures)
        : null;
  useEffect(() => {
    if (pollDelay === null) return;
    const timer = setTimeout(() => setTick((value) => value + 1), pollDelay);
    return () => clearTimeout(timer);
  }, [pollDelay, tick]);
  useEffect(() => {
    if (settled) return;
    const controller = new AbortController();
    const resolve = async (): Promise<ResolvedHost> => {
      const thread = await sdk.threads.get({
        threadId,
        signal: controller.signal,
      });
      if (thread.environmentId === null) return { kind: "waiting" };
      const environment = await sdk.environments.get({
        environmentId: thread.environmentId,
        signal: controller.signal,
      });
      const host = await sdk.hosts.get({
        hostId: environment.hostId,
        signal: controller.signal,
      });
      if (host.machineProviderId !== PROVIDER_ID) return { kind: "none" };
      switch (host.lifecycle.phase) {
        case "creating":
          return { kind: "creating", hostId: host.id };
        case "removing":
          return host.lifecycle.teardown?.status === "failed"
            ? { kind: "cleanup-failed", hostId: host.id }
            : { kind: "removing", hostId: host.id };
        case "destroyed":
          return { kind: "removed", hostId: host.id };
        default:
          return { kind: "active", hostId: host.id };
      }
    };
    resolve().then(
      (value) => {
        if (!controller.signal.aborted) setResolution({ threadId, value });
      },
      () => {
        if (controller.signal.aborted) return;
        setResolution((previous) => {
          const known = previous?.threadId === threadId ? previous.value : null;
          if (
            known !== null &&
            known.kind !== "retrying" &&
            known.kind !== "pending"
          ) {
            return previous;
          }
          return {
            threadId,
            value: {
              kind: "retrying",
              failures: known?.kind === "retrying" ? known.failures + 1 : 1,
            },
          };
        });
      },
    );
    return () => controller.abort();
  }, [sdk, threadId, tick, refreshKey, settled]);
  return current;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function formatRemaining(ms: number): { short: string; spoken: string } {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1)
    return { short: "<1m left", spoken: "less than a minute left" };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return {
      short: `${minutes}m left`,
      spoken: `${formatMinutes(minutes).spoken} left`,
    };
  }
  return {
    short: rest === 0 ? `${hours}h left` : `${hours}h ${rest}m left`,
    spoken: `${formatMinutes(minutes).spoken} left`,
  };
}

const REPORTED_STOP_STATES = new Set<MachineStatus["state"]>([
  "stopped",
  "failed",
  "aborted",
]);
const DEADLINE_OBSERVATION_DELAY_MS = 1_000;
const LOOKUP_RETRY_MAX_MS = 10 * 60_000;
const MAX_FOLLOW_UP_READS = 10;
const REFRESH_HINT = "Refresh to check again.";

function awaitsVendorStop(machine: MachineStatus, now: number): boolean {
  if (machine.computeEnded) return false;
  if (machine.state === "stopping" || machine.state === "snapshotting") {
    return true;
  }
  return (
    machine.state === "running" &&
    machine.expiresAt !== null &&
    machine.expiresAt <= now
  );
}

type ExpiryView = {
  tone: "muted" | "warning" | "destructive";
  label: string;
  spoken: string;
  detail: string;
  final: boolean;
};

function expiryView(
  resolution: HostResolution,
  inspection: Load<MachineStatus>,
  followingUp: boolean,
  now: number,
): ExpiryView | null {
  if (resolution.kind === "creating") {
    return {
      tone: "muted",
      label: "Starting",
      spoken: "starting",
      detail: `The sandbox is starting. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  if (resolution.kind === "removing") {
    return {
      tone: "warning",
      label: "Removing",
      spoken: "being removed",
      detail:
        "BB is removing this sandbox machine. Uncommitted files will be lost.",
      final: false,
    };
  }
  if (resolution.kind === "cleanup-failed") {
    return {
      tone: "warning",
      label: "Cleanup failed",
      spoken: "cleanup failed",
      detail: `BB couldn't finish removing this sandbox machine. The Vercel sandbox may still be running and billing your team. Retry cleanup in machine settings or with bb machine retry-cleanup ${resolution.hostId}.`,
      final: false,
    };
  }
  if (resolution.kind === "removed") {
    return {
      tone: "destructive",
      label: "Removed",
      spoken: "removed",
      detail:
        "BB removed this sandbox machine. It can't be restored; start a new thread to continue.",
      final: true,
    };
  }
  if (resolution.kind !== "active") return null;
  if (inspection.status === "pending") {
    return {
      tone: "muted",
      label: "Sandbox",
      spoken: "checking status",
      detail: "Checking the sandbox's time limit…",
      final: false,
    };
  }
  if (inspection.status === "error") {
    return {
      tone: "warning",
      label: "Sandbox",
      spoken: "status unavailable",
      detail: `Couldn't read the sandbox's time limit. ${DATA_LOSS_NOTE} If this keeps happening, check the Vercel account in plugin settings. ${REFRESH_HINT}`,
      final: false,
    };
  }
  const machine = inspection.data;
  const followUp = followingUp
    ? "BB checks Vercel again every 30 seconds for a few minutes."
    : REFRESH_HINT;
  if (machine.computeEnded) {
    return {
      tone: "destructive",
      label: "Stopped",
      spoken: "stopped",
      detail:
        "Vercel reports this sandbox's session stopped. BB keeps no snapshot, so its uncommitted files can't be recovered; start a new thread to continue.",
      final: true,
    };
  }
  if (REPORTED_STOP_STATES.has(machine.state)) {
    const state = machine.state;
    return {
      tone: "warning",
      label: `${state.charAt(0).toUpperCase()}${state.slice(1)}?`,
      spoken: `Vercel reports ${state}, stop unconfirmed`,
      detail: `Vercel reports this sandbox as ${state}, but hasn't confirmed it stopped. It may still be running; BB can't tell whether its files are still there. ${REFRESH_HINT}`,
      final: false,
    };
  }
  if (machine.state === "missing") {
    return {
      tone: "warning",
      label: "Unknown",
      spoken: "status unknown",
      detail: `Vercel can't find this sandbox right now. It may still be running while Vercel updates its records, or it may have stopped. BB can't tell whether its files are still there. ${REFRESH_HINT}`,
      final: false,
    };
  }
  if (machine.state === "pending") {
    return {
      tone: "muted",
      label: "Starting",
      spoken: "starting",
      detail: `The sandbox is starting. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  if (machine.state === "stopping" || machine.state === "snapshotting") {
    return {
      tone: "warning",
      label: "Stopping",
      spoken: "stopping",
      detail: `The sandbox is stopping. Uncommitted files will be lost when it stops. ${followUp}`,
      final: false,
    };
  }
  if (machine.expiresAt !== null && machine.expiresAt <= now) {
    return {
      tone: "warning",
      label: "Time limit reached",
      spoken: followingUp
        ? "time limit reached, checking Vercel status"
        : "time limit reached, Vercel hasn't reported a stop",
      detail: followingUp
        ? `The time limit has passed and Vercel hasn't reported the sandbox stopped yet. Uncommitted files will be lost when it stops. ${followUp}`
        : `The time limit has passed, but Vercel hasn't reported the sandbox stopped. Uncommitted files will be lost when it stops. ${REFRESH_HINT}`,
      final: false,
    };
  }
  if (machine.expiresAt === null) {
    return {
      tone: "muted",
      label: "Running",
      spoken: "running",
      detail: `Vercel didn't report a stop time. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  const remainingMs = machine.expiresAt - now;
  const remaining = formatRemaining(remainingMs);
  const stopsAt = new Date(machine.expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    tone: remainingMs <= WARNING_REMAINING_MS ? "warning" : "muted",
    label: remaining.short,
    spoken: remaining.spoken,
    detail: `Stops at ${stopsAt}. BB can't extend, pause, or save it. Commit and push work you want to keep.`,
    final: false,
  };
}

type Inspection = {
  hostId: string;
  observedAt: number;
  value: Load<MachineStatus>;
  summary: string | null;
  followUps: number;
};

function VercelExpiryIndicator({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const rpc = useRpc<Contract>();
  const headingId = useId();
  const [refreshKey, setRefreshKey] = useState(0);
  const resolution = useVercelHost(threadId, refreshKey);
  const hostId = resolution.kind === "active" ? resolution.hostId : null;
  const [observeKey, setObserveKey] = useState(0);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  useEffect(() => {
    if (hostId === null) return;
    let active = true;
    rpc.call("machine.inspect", { hostId }).then(
      (result) => {
        if (!active) return;
        const observedAt = Date.now();
        setInspection((previous) => ({
          hostId,
          observedAt,
          value: { status: "ready", data: result.values },
          summary: result.summary,
          followUps: awaitsVendorStop(result.values, observedAt)
            ? (previous?.hostId === hostId ? previous.followUps : 0) + 1
            : 0,
        }));
      },
      () => {
        if (!active) return;
        setInspection((previous) => ({
          hostId,
          observedAt: Date.now(),
          value: { status: "error" },
          summary: null,
          followUps: previous?.hostId === hostId ? previous.followUps : 0,
        }));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, hostId, refreshKey, observeKey]);
  const current =
    inspection !== null && inspection.hostId === hostId ? inspection : null;
  const machine: Load<MachineStatus> = current?.value ?? { status: "pending" };
  const deadline =
    machine.status === "ready" && !machine.data.computeEnded
      ? machine.data.expiresAt
      : null;
  const observedAt = current?.observedAt ?? null;
  useEffect(() => {
    if (deadline === null || observedAt === null || observedAt > deadline)
      return;
    const timer = setTimeout(
      () => setObserveKey((value) => value + 1),
      Math.max(0, deadline - Date.now()) + DEADLINE_OBSERVATION_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [deadline, observedAt]);
  const followUps = current?.followUps ?? 0;
  const followingUp = followUps > 0 && followUps < MAX_FOLLOW_UP_READS;
  useEffect(() => {
    if (!followingUp) return;
    const timer = setTimeout(
      () => setObserveKey((value) => value + 1),
      TICK_MS,
    );
    return () => clearTimeout(timer);
  }, [followingUp, observedAt]);
  const counting =
    machine.status === "ready" &&
    machine.data.state === "running" &&
    !machine.data.computeEnded &&
    machine.data.expiresAt !== null;
  const tickNow = useNow(counting);
  const now = Math.max(tickNow, observedAt ?? 0);
  const view = expiryView(resolution, machine, followingUp, now);
  if (view === null) return null;
  const refresh = () => setRefreshKey((value) => value + 1);
  const toneClass =
    view.tone === "destructive"
      ? "text-destructive-text"
      : view.tone === "warning"
        ? "text-warning-text"
        : OPTION_MUTED_CLASS_NAME;
  const details =
    machine.status === "ready" && !view.final
      ? {
          size: sizeLabel(machine.data.vcpus, machine.data.memoryMiB),
          name: machine.data.sandboxName,
        }
      : null;
  const guidance =
    machine.status === "ready" && machine.data.state === "missing"
      ? (current?.summary ?? null)
      : null;
  return (
    <Popover
      onOpenChange={(open) => (open && !view.final ? refresh() : undefined)}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Vercel sandbox: ${view.spoken}`}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            "h-7",
            toneClass,
          )}
        >
          <Icon
            name={view.tone === "muted" ? "Clock" : "AlertTriangle"}
            className={cn("shrink-0", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
          />
          {isCompactViewport ? null : (
            <span className="min-w-0 truncate">{view.label}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        mobileTitle="Vercel sandbox"
        aria-labelledby={headingId}
        className="w-80 space-y-2 p-3"
      >
        <h3 id={headingId} className="text-xs font-medium text-foreground">
          Vercel sandbox
        </h3>
        <p
          className={cn(
            "text-xs leading-relaxed",
            view.tone === "muted" ? "text-foreground" : toneClass,
          )}
        >
          {view.detail}
        </p>
        {guidance === null || guidance === "" ? null : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {guidance}
          </p>
        )}
        {details === null ? null : (
          <p className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>{details.size}</span>
            <span className="truncate font-mono">{details.name}</span>
          </p>
        )}
        {view.final ? null : (
          <Button type="button" size="sm" variant="outline" onClick={refresh}>
            <Icon name="ArrowReloadHorizontal" className="size-3.5" />
            {machine.status === "error" ? "Retry" : "Refresh"}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_machineProviderInputs({
    machineProviderId: PROVIDER_ID,
    component: VercelMachineInputsControl,
  });
  app.slots.settingsSection({
    id: "sandbox",
    component: VercelSettingsSection,
  });
  app.slots.experimental_threadHeaderAction({
    id: "expiry",
    title: "Vercel sandbox time limit",
    component: VercelExpiryIndicator,
  });
});
