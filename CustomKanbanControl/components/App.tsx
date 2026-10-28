import * as React from "react";
import {
    DndContext,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import { KanbanCardData, StageOption } from "../types";
import {
    ALIAS_GROUP,
    buildCards,
    buildColumns,
    getBaseFieldLogicalName,
    getColumnLogicalName,
    resolveBaseColumn,
} from "../services/DataService";
import {
    UserCurrency,
    baseKey,
    fetchBaseValues,
    getPrimaryIdAttribute,
    getUserCurrency,
} from "../services/CurrencyService";
import { getChoiceOptions, FALLBACK_COLOR } from "../services/MetadataService";
import {
    checkBpfRequiredFields,
    MissingStageFields,
} from "../services/Bpfrequiredservice";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCardGhost } from "./KanbanCard";
import { RequiredFieldsDialog } from "./RequiredFieldsDialog";

type DataSet = ComponentFramework.PropertyTypes.DataSet;

// Cards are sorted by Modified On, newest first.
// The sort is applied to the dataset (server side) so it stays correct as
// further pages are loaded.

export interface AppProps {
    context: ComponentFramework.Context<unknown>;
    dataset: DataSet;
    ownerColumn: string;
    boardHeight: number;
    /** Block moves while the BPF stage being left has empty required fields. */
    validateBpf: boolean;
}

export const App: React.FC<AppProps> = (props) => {
    const { context, dataset, ownerColumn, boardHeight, validateBpf } = props;
    const SORT_FIELD = "modifiedon";
    const SORT_DESCENDING = 1;

    const [stageOptions, setStageOptions] = React.useState<StageOption[]>([]);
    const [overrides, setOverrides] = React.useState<Record<string, number>>({});
    const [savingIds, setSavingIds] = React.useState<Set<string>>(new Set());
    const [justMovedId, setJustMovedId] = React.useState<string | null>(null);
    const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
    const [search, setSearch] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [activeCard, setActiveCard] = React.useState<KanbanCardData | null>(null);
    const [loadingMore, setLoadingMore] = React.useState(false);

    // Currency of the logged-in user (falls back to the org base currency).
    const [userCurrency, setUserCurrency] = React.useState<UserCurrency | null>(null);
    const [currencyResolved, setCurrencyResolved] = React.useState(false);
    // Base-currency amounts fetched on demand when the "<field>_base" column
    // is not part of the view. Keyed by the normalised record id.
    const [baseValues, setBaseValues] = React.useState<Record<string, number>>({});
    const [baseFetchFailed, setBaseFetchFailed] = React.useState(false);
    const sortAppliedRef = React.useRef(false);

    // Move blocked because BPF-required fields are empty
    const [blocked, setBlocked] = React.useState<{
        card: KanbanCardData;
        targetLabel: string;
        accentColor: string;
        missing: MissingStageFields[];
    } | null>(null);

    const entityName = dataset.getTargetEntityType();
    const groupByLogicalName = getColumnLogicalName(dataset, ALIAS_GROUP);
    const baseColumn = React.useMemo(() => resolveBaseColumn(dataset), [dataset]);
    const baseFieldName = React.useMemo(() => getBaseFieldLogicalName(dataset), [dataset]);

    // ---- Sort cards newest -> oldest by Modified On (once) -----------
    React.useEffect(() => {
        if (sortAppliedRef.current) {
            return;
        }
        sortAppliedRef.current = true;
        const current = dataset.sorting;
        const alreadySorted =
            current.length === 1 &&
            current[0].name === SORT_FIELD &&
            Number(current[0].sortDirection) === SORT_DESCENDING;
        if (alreadySorted) {
            return;
        }
        while (dataset.sorting.length > 0) {
            dataset.sorting.pop();
        }
        dataset.sorting.push({
            name: SORT_FIELD,
            sortDirection: SORT_DESCENDING,
        } as unknown as (typeof dataset.sorting)[0]);
        dataset.refresh();
    }, [dataset, SORT_FIELD, SORT_DESCENDING]);

    // ---- Resolve the currency the totals are shown in (once) ---------
    React.useEffect(() => {
        let cancelled = false;
        const load = async (): Promise<void> => {
            const currency = await getUserCurrency(context);
            if (!cancelled) {
                setUserCurrency(currency);
                setCurrencyResolved(true);
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [context]);

    // ---- Load choice column metadata (labels + colors) once ----------
    React.useEffect(() => {
        let cancelled = false;
        if (!entityName || !groupByLogicalName) {
            return undefined;
        }
        const load = async (): Promise<void> => {
            try {
                const options = await getChoiceOptions(context, entityName, groupByLogicalName);
                if (!cancelled) {
                    setStageOptions(options);
                }
            } catch {
                /* board falls back to data-derived columns */
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [entityName, groupByLogicalName]);

    // ---- Drop overrides that the server data has caught up with ------
    React.useEffect(() => {
        if (Object.keys(overrides).length === 0) {
            return;
        }
        const next: Record<string, number> = {};
        let changed = false;
        for (const id of Object.keys(overrides)) {
            const record = dataset.records[id];
            const serverValue = record ? Number(record.getValue(ALIAS_GROUP)) : NaN;
            if (record && serverValue === overrides[id]) {
                changed = true; // server caught up — drop the override
            } else {
                next[id] = overrides[id];
            }
        }
        if (changed) {
            setOverrides(next);
        }
    }, [dataset]);

    // ---- Build view model ---------------------------------------------
    const allCards = React.useMemo(
        () => buildCards(dataset, ownerColumn, overrides, baseColumn, baseValues),
        [dataset, ownerColumn, overrides, baseColumn, baseValues]
    );

    // ---- Fetch base amounts when the column is not on the view -------
    React.useEffect(() => {
        if (baseColumn !== null || baseFieldName === null || baseFetchFailed || !entityName) {
            return undefined;
        }
        const missing = allCards
            .filter((c) => baseValues[baseKey(c.id)] === undefined)
            .map((c) => c.id);
        if (missing.length === 0) {
            return undefined;
        }
        let cancelled = false;
        const load = async (): Promise<void> => {
            try {
                const idAttribute = await getPrimaryIdAttribute(context, entityName);
                const fetched = await fetchBaseValues(
                    context,
                    entityName,
                    idAttribute,
                    baseFieldName,
                    missing
                );
                if (!cancelled) {
                    setBaseValues((prev) => ({ ...prev, ...fetched }));
                }
            } catch {
                // No base column and no way to read it - totals fall back to
                // the raw amounts, exactly as before this change.
                if (!cancelled) {
                    setBaseFetchFailed(true);
                }
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [context, entityName, allCards, baseValues, baseColumn, baseFieldName, baseFetchFailed]);

    const filteredCards = React.useMemo(() => {
        const term = search.trim().toLowerCase();
        if (term === "") {
            return allCards;
        }
        // Every term must appear somewhere in the card's searchable text
        // (title, owner, account, opportunity id / number, and every other
        // column on the view). Multiple words = AND, so "acme 0708" works.
        const terms = term.split(/\s+/);
        return allCards.filter((c) => terms.every((t) => c.searchText.includes(t)));
    }, [allCards, search]);

    // Base amounts are usable once every card has one (or the column is bound).
    const baseReady =
        !baseFetchFailed &&
        (baseColumn !== null ||
            (allCards.length > 0 && allCards.every((c) => c.valueBase !== null)));
    const useBase = baseReady && userCurrency !== null;
    // Still resolving - show no total rather than a wrong one for a moment.
    const basePending =
        !currencyResolved ||
        (!baseFetchFailed && baseFieldName !== null && allCards.length > 0 && !baseReady);

    /**
     * Totals are summed in the org base currency and converted to the user's
     * currency: base * exchangerate ("the value of a transaction currency equal
     * to one base currency"). Formatting uses that currency's own symbol and
     * precision instead of whatever the default formatter picks.
     */
    const formatMoney = React.useCallback(
        (value: number): string => {
            if (basePending) {
                return "";
            }
            if (useBase && userCurrency) {
                return context.formatting.formatCurrency(
                    value * userCurrency.exchangeRate,
                    userCurrency.precision,
                    userCurrency.symbol
                );
            }
            return context.formatting.formatCurrency(value);
        },
        [context, useBase, userCurrency, basePending]
    );

    const columns = React.useMemo(() => {
        const built = buildColumns(filteredCards, stageOptions, formatMoney, useBase);
        if (justMovedId) {
            for (const col of built) {
                const idx = col.cards.findIndex((c) => c.id === justMovedId);
                if (idx > 0) {
                    const [moved] = col.cards.splice(idx, 1);
                    col.cards.unshift(moved);
                }
            }
        }
        return built;
    }, [filteredCards, stageOptions, formatMoney, useBase, justMovedId]);

    const totalSum = React.useMemo(
        () => columns.reduce((acc, c) => acc + c.sum, 0),
        [columns]
    );
    const totalFormatted = totalSum > 0 ? formatMoney(totalSum) : "";
    const totalTitle =
        useBase && userCurrency
            ? `Total converted to ${userCurrency.isoCode || userCurrency.symbol}`
            : "Total";

    // ---- Drag & drop ----------------------------------------------------
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } })
    );

    const onDragStart = (event: DragStartEvent) => {
        const card = event.active.data.current?.card as KanbanCardData | undefined;
        setActiveCard(card ?? null);
    };

    const onDragEnd = (event: DragEndEvent) => {
        setActiveCard(null);
        const { active, over } = event;
        if (!over) {
            return;
        }
        const card = active.data.current?.card as KanbanCardData | undefined;
        const targetValue = over.data.current?.columnValue as number | null | undefined;
        if (!card || targetValue === null || targetValue === undefined) {
            return;
        }
        if (card.groupValue === targetValue) {
            return;
        }
        void handleDrop(card, targetValue);
    };

    /**
     * On drop: if BPF validation is on, block the move while the stage(s)
     * being left have empty business-required fields; otherwise save the
     * new choice value immediately.
     */
    const handleDrop = async (card: KanbanCardData, targetValue: number) => {
        if (!groupByLogicalName) {
            setError("Cannot update: the group-by column was not found in the view.");
            return;
        }
        // Gate on the stage the card is LEAVING (its current group value),
        // not the stage it's moving into.
        const sourceValue = card.groupValue;
        const stageName =
            sourceValue === null
                ? ""
                : (columns.find((c) => c.value === sourceValue)?.label ??
                  stageOptions.find((o) => o.value === sourceValue)?.label ??
                  "");

        setError(null);

        // Determine direction using the stage order from metadata.
        // Backward (or same-position) moves are NOT gated — move freely.
        const sourceIndex = stageOptions.findIndex((o) => o.value === sourceValue);
        const targetIndex = stageOptions.findIndex((o) => o.value === targetValue);
        let isForward: boolean;
        if (sourceIndex !== -1 && targetIndex !== -1) {
            isForward = targetIndex > sourceIndex;
        } else if (sourceValue !== null) {
            // Fallback when metadata order is unavailable: compare choice values
            // (stage option values are typically sequential).
            isForward = targetValue > sourceValue;
        } else {
            isForward = true; // no source stage → treat as forward
        }

        // Stages the card is LEAVING on a forward move: source .. target-1
        // (handles multi-stage jumps). Both gates below operate on these.
        const targetLabel =
            columns.find((c) => c.value === targetValue)?.label ??
            stageOptions.find((o) => o.value === targetValue)?.label ??
            "";
        let stagesToCheck: string[] = [];
        if (isForward) {
            if (sourceIndex !== -1 && targetIndex !== -1) {
                stagesToCheck = stageOptions
                    .slice(sourceIndex, targetIndex)
                    .map((o) => o.label);
            } else if (stageName !== "") {
                stagesToCheck = [stageName];
            }
        }

        // ---- Gate: BPF business-required fields --------------------
        // Each stage being left must have its business-required fields
        // filled (same rule the BPF itself enforces on "Next Stage").
        // Blocked → the card never moves.
        if (stagesToCheck.length > 0 && validateBpf) {
            setSavingIds((prev) => new Set(prev).add(card.id));
                try {
                    const check = await checkBpfRequiredFields(
                        context,
                        entityName,
                        card.id,
                        stagesToCheck
                    );
                    if (!check.ok) {
                        const accentColor =
                            columns.find((c) => c.value === sourceValue)?.color ??
                            FALLBACK_COLOR;
                        setBlocked({
                            card,
                            targetLabel,
                            accentColor,
                            missing: check.missing,
                        });
                        return; // card stays where it is
                    }
                } catch {
                    /* fail open — a technical error must not block the move */
                } finally {
                    setSavingIds((prev) => {
                        const next = new Set(prev);
                        next.delete(card.id);
                        return next;
                    });
                }
        }

        await commitMove(card, targetValue);
    };

    /** Performs the actual stage change with optimistic UI + revert. */
    const commitMove = async (card: KanbanCardData, targetValue: number) => {
        if (!groupByLogicalName) {
            return;
        }
        const previous = card.groupValue;
        setOverrides((prev) => ({ ...prev, [card.id]: targetValue }));
        setSavingIds((prev) => new Set(prev).add(card.id));
        try {
            await context.webAPI.updateRecord(entityName, card.id, {
                [groupByLogicalName]: targetValue,
            });
            // Highlight the moved card and lift it to the top of its new column.
            setJustMovedId(card.id);
            window.setTimeout(() => {
                setJustMovedId((cur) => (cur === card.id ? null : cur));
            }, 4000);
        } catch (e) {
            setOverrides((prev) => {
                const next = { ...prev };
                if (previous === null) {
                    delete next[card.id];
                } else {
                    next[card.id] = previous;
                }
                return next;
            });
            const message =
                (e as { message?: string })?.message ?? "The record could not be updated.";
            setError(`Could not move "${card.title}": ${message}`);
        } finally {
            setSavingIds((prev) => {
                const next = new Set(prev);
                next.delete(card.id);
                return next;
            });
        }
    };

    // ---- Actions ---------------------------------------------------------
    const openRecord = (card: KanbanCardData) => {
        dataset.openDatasetItem(card.reference);
    };

    const toggleCollapse = (value: number | null) => {
        const key = value === null ? "null" : String(value);
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const loadMore = React.useCallback(() => {
        if (loadingMore || !dataset.paging.hasNextPage) {
            return;
        }
        setLoadingMore(true);
        try {
            dataset.paging.loadNextPage();
        } finally {
            // updateView re-renders with the new page; clear the flag shortly after
            window.setTimeout(() => setLoadingMore(false), 800);
        }
    }, [dataset, loadingMore]);

    // ---- Render -----------------------------------------------------------
    if (dataset.loading && allCards.length === 0) {
        return (
            <div className="dtk-board" style={{ height: "100%", minHeight: boardHeight }}>
                <div className="dtk-loading">
                    <div className="dtk-spinner" />
                    <span>Loading records…</span>
                </div>
            </div>
        );
    }

    return (
        <div className="dtk-board" style={{ height: "100%", minHeight: boardHeight }}>
            <div className="dtk-toolbar">
                <div className="dtk-toolbar__stats">
                    <span className="dtk-toolbar__count">
                        {filteredCards.length} record{filteredCards.length === 1 ? "" : "s"}
                    </span>
                    {totalFormatted !== "" && (
                        <span className="dtk-toolbar__sum" title={totalTitle}>
                            {totalFormatted}
                        </span>
                    )}
                </div>
                <div className="dtk-toolbar__actions">
                    <input
                        className="dtk-toolbar__search"
                        type="text"
                        placeholder="Filter by name, account, ID…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    {dataset.paging.hasNextPage && (
                        <button
                            className="dtk-toolbar__btn"
                            onClick={() => void loadMore()}
                            disabled={loadingMore}
                        >
                            {loadingMore ? "Loading…" : "Load more"}
                        </button>
                    )}
                    <button
                        className="dtk-toolbar__btn"
                        title="Refresh"
                        onClick={() => dataset.refresh()}
                    >
                        ⟳
                    </button>
                </div>
            </div>

            {error && (
                <div className="dtk-error" role="alert">
                    <span>{error}</span>
                    <button className="dtk-error__close" onClick={() => setError(null)}>
                        ✕
                    </button>
                </div>
            )}

            <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
                <div className="dtk-columns">
                    {columns.map((col) => (
                        <KanbanColumn
                            key={col.value === null ? "null" : col.value}
                            column={col}
                            totalCount={filteredCards.length}
                            collapsed={collapsed.has(col.value === null ? "null" : String(col.value))}
                            onToggleCollapse={toggleCollapse}
                            onOpen={openRecord}
                            onNearBottom={loadMore}
                            savingIds={savingIds}
                            justMovedId={justMovedId}
                        />
                    ))}
                </div>
                <DragOverlay dropAnimation={null}>
                    {activeCard ? (
                        <KanbanCardGhost
                            card={activeCard}
                            accentColor={
                                columns.find((c) => c.value === activeCard.groupValue)?.color ??
                                FALLBACK_COLOR
                            }
                        />
                    ) : null}
                </DragOverlay>
            </DndContext>

            {blocked && (
                <RequiredFieldsDialog
                    recordTitle={blocked.card.title}
                    targetStage={blocked.targetLabel}
                    accentColor={blocked.accentColor}
                    missing={blocked.missing}
                    onOpenRecord={() => dataset.openDatasetItem(blocked.card.reference)}
                    onClose={() => setBlocked(null)}
                />
            )}

        </div>
    );
};