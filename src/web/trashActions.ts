// Deleting an issue or a doc: both send it to the trash, undoable (as in Linear, so no confirm first),
// then navigate away from the page that no longer has anything to show.
import { errorToast, navigate, trashToast } from "./ui";

export async function deleteToTrash(del: () => Promise<unknown>, label: string, restore: () => Promise<unknown>, itemHref: string, goTo: string) {
  try {
    await del();
    trashToast(label, restore, itemHref);
    navigate(goTo);
  } catch (e) {
    errorToast(e);
  }
}
