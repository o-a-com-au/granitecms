// The swappable media storage driver interface - local filesystem is
// the only implementation today (local-fs-driver.ts), config-driven
// object storage is later, separately-scoped work behind this same
// interface (docs/cms-build-plan.md's Phase 4). Promise-returning even
// though the local implementation is internally synchronous, unlike
// search/drivers/driver.ts's own SearchDriver (sync only because
// DatabaseSync itself is sync) - a future object-storage driver is
// inherently network/async, and this interface has to work for both
// without a later breaking change.
//
// filename is always a bare, flat, relative name - content-addressed,
// no subdirectories (see filename.ts) - never an absolute path, so a
// future object-storage driver can implement this with plain "key"
// semantics and no "root directory" concept at all.
export interface MediaListEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface MediaStorageDriver {
  list(): Promise<MediaListEntry[]>;
  put(filename: string, bytes: Buffer): Promise<void>;
  // null, not a thrown error, for "not found" - mirrors
  // manage-redirects.ts/manage-menus.ts's own "let the service layer
  // decide the domain error" split, keeping the driver itself
  // mechanical, the same way SearchDriver carries no domain meaning.
  get(filename: string): Promise<Buffer | null>;
  // false, not a thrown error, for "didn't exist" - same reasoning.
  delete(filename: string): Promise<boolean>;
}
