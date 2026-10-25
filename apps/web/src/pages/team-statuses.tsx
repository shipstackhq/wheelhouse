import { useState } from "react";
import clsx from "clsx";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Dialog, DropdownMenu } from "radix-ui";
import type { StatusColor, StatusRole, StatusSetting } from "@wheelhouse/api-client";
import { REQUIRED_ROLES, STATUS_NAME_MAX } from "@wheelhouse/shared/status-roles";
import { TEAM_ICON_COLORS } from "@wheelhouse/shared/team-icon";
import { Loaded } from "../components/query-state";
import { AddIcon, CloseIcon, MenuIcon } from "../components/icons";
import { StatusIcon } from "../components/status-icon";
import { ICON_COLOR_CLASS } from "../components/team-icon";
import { Select } from "../components/ui";
import { describeFailure } from "../lib/form-state";
import { useStatuses } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { groupStatuses, reorderWithinGroup, ROLE_LABEL, type Group } from "../lib/status-order";

const MENU = "z-50 min-w-40 rounded-lg border border-line bg-panel p-1 text-sm text-fg shadow-xl";
const ITEM = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-panel-2";

/**
 * A team's statuses, grouped by role: rename a status where it stands, pick its colour, make it its role's default, drag it into order
 * within its role, add one to a role, delete one (saying where its issues go). Any member sees the list; only team admins change it.
 */
export function StatusesSection({ teamKey, canEdit }: { teamKey: string; canEdit: boolean }) {
  const query = useStatuses(teamKey);
  return (
    <Loaded query={query} label="Loading the statuses">
      {(list) => <Editor teamKey={teamKey} canEdit={canEdit} list={list} />}
    </Loaded>
  );
}

function Editor({ teamKey, canEdit, list }: { teamKey: string; canEdit: boolean; list: StatusSetting[] }) {
  const { api, queryClient } = useServices();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<StatusSetting | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const groups = groupStatuses(list);

  /** Run one change, then read everything again; a refusal from the server is shown above the list. */
  const run = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
      await refreshAll(queryClient);
    } catch (e) {
      setError(describeFailure(e));
    }
  };
  const onDragEnd = (role: StatusRole) => (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = reorderWithinGroup(list, role, String(e.active.id), String(e.over.id));
    if (ids.every((id, i) => id === list[i].id)) return; // dropped where it was, or on another role's status: nothing to save
    void run(() => api.statuses.reorder(teamKey, ids));
  };

  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-5">
        {groups.map((g) => (
          <section key={g.role} aria-label={g.label}>
            <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{g.label}</h3>
            <DndContext id={`statuses-${g.role}`} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(g.role)}>
              <SortableContext items={g.items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {g.items.map((s) => (
                    <Row
                      key={s.id}
                      status={s}
                      group={g}
                      canEdit={canEdit}
                      onRename={(name) => run(() => api.statuses.update(teamKey, s.id, { name }))}
                      onColor={(color) => run(() => api.statuses.update(teamKey, s.id, { color }))}
                      onDefault={() => run(() => api.statuses.update(teamKey, s.id, { isDefault: true }))}
                      onDelete={() => setDeleting(s)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            {canEdit && <AddStatus role={g.role} onAdd={(name) => run(() => api.statuses.create(teamKey, { name, role: g.role }))} />}
          </section>
        ))}
      </div>
      {deleting && (
        <DeleteDialog
          status={deleting}
          others={list.filter((s) => s.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDelete={async (moveTo) => {
            setDeleting(null);
            await run(() => api.statuses.remove(teamKey, deleting.id, moveTo));
          }}
        />
      )}
    </div>
  );
}

function Row(props: {
  status: StatusSetting;
  group: Group<StatusSetting>;
  canEdit: boolean;
  onRename: (name: string) => void;
  onColor: (color: StatusColor | null) => void;
  onDefault: () => void;
  onDelete: () => void;
}) {
  const { status: s, group, canEdit } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id, disabled: !canEdit });
  const lastOfRequired = (REQUIRED_ROLES as readonly string[]).includes(s.role) && group.items.length === 1;
  const shared = group.items.length > 1;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx("flex items-center gap-2 bg-panel px-2 py-1.5", isDragging && "relative z-10 shadow-lg")}
      data-status={s.name}
    >
      {canEdit && (
        <button type="button" aria-label={`Reorder ${s.name}`} className="cursor-grab touch-none rounded p-1 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50" {...attributes} {...listeners}>
          <MenuIcon aria-hidden />
        </button>
      )}
      {canEdit ? (
        <ColorMenu name={s.name} role={s.role} color={s.color} onPick={props.onColor} />
      ) : (
        <StatusIcon role={s.role} color={s.color} />
      )}
      {canEdit ? (
        <input
          key={s.name}
          aria-label={`Name of ${s.name}`}
          className="min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 outline-none hover:bg-panel-2 focus:bg-panel-2 focus:ring-2 focus:ring-accent/50"
          defaultValue={s.name}
          maxLength={STATUS_NAME_MAX}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = s.name;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            if (!name) e.currentTarget.value = s.name;
            else if (name !== s.name) props.onRename(name);
          }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate px-1.5 py-1">{s.name}</span>
      )}
      {shared && s.isDefault && <span className="chip bg-accent/15 text-accent">Default</span>}
      {canEdit && shared && !s.isDefault && (
        <button type="button" className="text-xs text-muted outline-none hover:text-fg focus-visible:underline" onClick={props.onDefault} aria-label={`Make ${s.name} the default ${ROLE_LABEL[s.role].toLowerCase()} status`}>
          Make default
        </button>
      )}
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">{s.issueCount === 1 ? "1 issue" : `${s.issueCount} issues`}</span>
      {canEdit && (
        <button
          type="button"
          aria-label={`Delete ${s.name}`}
          title={lastOfRequired ? `A team needs at least one ${ROLE_LABEL[s.role].toLowerCase()} status` : undefined}
          disabled={lastOfRequired}
          onClick={props.onDelete}
          className="rounded p-1 text-muted outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-muted"
        >
          <CloseIcon aria-hidden />
        </button>
      )}
    </li>
  );
}

function ColorMenu(props: { name: string; role: string; color: StatusColor | null; onPick: (color: StatusColor | null) => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={`Colour of ${props.name}`} className="rounded p-1 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50">
        <StatusIcon role={props.role} color={props.color} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={MENU}>
          {TEAM_ICON_COLORS.map((c) => (
            <DropdownMenu.Item key={c} className={ITEM} onSelect={() => props.color !== c && props.onPick(c)}>
              <span className={clsx("size-3 rounded-full", ICON_COLOR_CLASS[c].bg)} aria-hidden />
              <span className="capitalize">{c}</span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={ITEM} onSelect={() => props.color !== null && props.onPick(null)}>
            Colour of its role
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AddStatus({ role, onAdd }: { role: StatusRole; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const close = () => {
    setOpen(false);
    setName("");
  };
  if (!open) {
    return (
      <button type="button" className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50" onClick={() => setOpen(true)}>
        <AddIcon aria-hidden /> Add {ROLE_LABEL[role].toLowerCase()} status
      </button>
    );
  }
  return (
    <form
      className="mt-1 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const v = name.trim();
        if (v) onAdd(v);
        close();
      }}
    >
      <StatusIcon role={role} />
      <input
        autoFocus
        className="input min-w-0 flex-1 py-1"
        aria-label={`New ${ROLE_LABEL[role].toLowerCase()} status`}
        value={name}
        maxLength={STATUS_NAME_MAX}
        placeholder="Name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && close()}
      />
      <button type="submit" className="btn btn-primary py-1">Add</button>
      <button type="button" className="btn py-1" onClick={close}>Cancel</button>
    </form>
  );
}

function DeleteDialog(props: { status: StatusSetting; others: StatusSetting[]; onClose: () => void; onDelete: (moveTo?: string) => void }) {
  const { status: s, others } = props;
  // Where its issues go unless the person says otherwise: the default of its own role, else the first status that is left.
  const first = others.find((o) => o.role === s.role && o.isDefault) ?? others[0];
  const [moveTo, setMoveTo] = useState(first?.id ?? "");
  const has = s.issueCount > 0;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
          <Dialog.Title className="font-semibold">Delete {s.name}?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted">
            {has ? `${s.issueCount === 1 ? "1 issue is" : `${s.issueCount} issues are`} in it. Choose where ${s.issueCount === 1 ? "it goes" : "they go"}.` : "No issue is in it."}
          </Dialog.Description>
          {has && (
            <div className="mt-4">
              <label className="label">Move {s.issueCount === 1 ? "the issue" : "the issues"} to</label>
              <Select ariaLabel="Move issues to" value={moveTo} options={others.map((o) => ({ value: o.id, label: o.name }))} onValueChange={setMoveTo} />
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={() => props.onDelete(has ? moveTo : undefined)}>Delete status</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
