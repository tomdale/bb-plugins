// Deleting a walkthrough: the confirm dialog shared by the Walkthroughs index
// and a walkthrough's own menu, and the empty state a pane shows once the
// walkthrough it was reading is gone.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PAGE_PATH } from "../schemas.ts";
import { errorMessage, type WalkthroughRpc } from "./hooks.ts";

export interface DeleteTarget {
  id: string;
  /** What the reader calls it: the dialog names it. */
  title: string;
}

/**
 * The caller keeps `target` after the dialog closes and flips only `open`, so
 * the dialog's text stays put while it animates away.
 */
export function DeleteWalkthroughDialog({
  target,
  open,
  onOpenChange,
  rpc,
  onDeleted,
  restoreFocus,
}: {
  target: DeleteTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rpc: WalkthroughRpc;
  /** Runs once the walkthrough is gone, before the dialog closes. */
  onDeleted?: (target: DeleteTarget) => void;
  /** Where focus goes when the dialog closes after a delete; the opener may no longer exist. */
  restoreFocus?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedHere, setDeletedHere] = useState(false);
  const remove = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("delete", { walkthroughId: target.id });
      setDeletedHere(true);
      onDeleted?.(target);
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) {
          setError(null);
          setDeletedHere(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="wt-portal wt-dialog wt-delete"
        onCloseAutoFocus={(event) => {
          if (deletedHere && restoreFocus) {
            event.preventDefault();
            restoreFocus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete “{target?.title}”?</DialogTitle>
          <DialogDescription>
            This removes the walkthrough, its notes, and your questions and the answers. Its helper thread is archived. Notes you saved to a file stay where they are.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="wt-delete-error">
            {error}
          </p>
        ) : null}
        <DialogFooter className="wt-dialog-actions">
          <Button type="button" variant="ghost" className="wt-btn wt-btn-quiet" disabled={busy} onClick={() => onOpenChange(false)}>
            Keep
          </Button>
          <Button type="button" className="wt-btn wt-btn-danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete walkthrough"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a pane shows for a walkthrough that no longer exists (deleted here, in another pane, or before this one opened). */
export function DeletedPage() {
  const navigate = useBbNavigate();
  return (
    <div className="wt">
      <div className="wt-scroll">
        <div className="wt-page wt-deleted">
          <header className="wt-head">
            <h2>This walkthrough was deleted</h2>
          </header>
          <p className="wt-muted">Its notes and questions are gone with it.</p>
          <p>
            <button type="button" className="wt-link-btn" onClick={() => navigate.toPluginPanel(PAGE_PATH)}>
              See your other walkthroughs
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
