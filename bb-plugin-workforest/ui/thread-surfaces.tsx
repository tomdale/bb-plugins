import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button.js";
import { Icon } from "../components/ui/icon.js";
import type { rpcContract } from "../contracts.js";
import { useResource } from "../hooks/use-resource.js";
import { Empty, ErrorMessage } from "./shared.js";
import { WorkspaceDetail } from "./workspace.js";
export function ThreadPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useResource(`context:${threadId}`, () =>
    rpc.call("context", { threadId }),
  );
  const bootstrap = useResource(
    "bootstrap",
    () => rpc.call("bootstrap"),
    30000,
  );
  return (
    <div className="space-y-3">
      <ErrorMessage message={context.error || bootstrap.error} />
      {context.data?.entry && bootstrap.data ? (
        <WorkspaceDetail
          key={`${context.data.hostId}:${context.data.entry.selector}`}
          hostId={context.data.hostId}
          selector={context.data.entry.selector}
          bootstrap={bootstrap.data}
        />
      ) : (
        <Empty>
          {context.data === undefined
            ? "Checking Workforest context…"
            : "This thread is not in a Workforest-managed checkout."}
          <div className="mt-3">
            <Button
              variant="outline"
              onClick={() => navigate.toPluginPanel("workspaces")}
            >
              Browse Workforest
            </Button>
          </div>
        </Empty>
      )}
    </div>
  );
}
export function ThreadHeader({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useResource(
    `header:${threadId}`,
    () => rpc.call("context", { threadId }),
    30000,
  );
  if (!context.data?.entry) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 max-w-40 gap-1.5 px-2"
      aria-label={`Open Workforest workspace ${context.data.entry.selector}`}
      onClick={() =>
        navigate.openThreadPanel({ actionId: "workspace", title: "Workforest" })
      }
    >
      <Icon name="GitBranch" className="size-3.5" />
      <span className="truncate text-xs" title={context.data.entry.selector}>
        {context.data.entry.selector}
      </span>
    </Button>
  );
}
