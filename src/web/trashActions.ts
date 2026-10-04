// Deleting an issue or a doc: both send it to the trash, undoable (as in Linear, so no confirm first),
// then navigate away from the page that no longer has anything to show.
import { ask, errorToast, navigate, toast, trashToast } from "./ui";

export async function deleteToTrash(del: () => Promise<unknown>, label: string, restore: () => Promise<unknown>, itemHref: string, goTo: string) {
  try {
    await del();
    trashToast(label, restore, itemHref);
    navigate(goTo);
  } catch (e) {
    errorToast(e);
  }
}

/** Deleting a trashed issue or doc for good, after a confirm: by hand only, there is no undo. `then` runs once it's gone. */
export async function purgeForever(purge: () => Promise<unknown>, label: string, then: () => void) {
  if (!(await ask(`Delete ${label} forever? This can’t be undone.`, "Delete forever"))) return;
  try {
    await purge();
    toast(`Deleted ${label} forever`);
    then();
  } catch (e) {
    errorToast(e);
  }
}
