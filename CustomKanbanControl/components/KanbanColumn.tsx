import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { KanbanColumnData, KanbanCardData } from "../types";
import { KanbanCard } from "./KanbanCard";

export interface KanbanColumnProps {
    column: KanbanColumnData;
    totalCount: number;
    collapsed: boolean;
    onToggleCollapse: (value: number | null) => void;
    onOpen: (card: KanbanCardData) => void;
    onNearBottom: () => void;
    savingIds: Set<string>;
    justMovedId: string | null;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = (props) => {
    const {
        column,
        collapsed,
        onToggleCollapse,
        onOpen,
        onNearBottom,
        savingIds,
        justMovedId,
        totalCount,
    } = props;
    const droppableId = column.value === null ? "col-null" : `col-${column.value}`;
    const { setNodeRef, isOver } = useDroppable({
        id: droppableId,
        data: { columnValue: column.value },
    });

    const accentStyle = {
        ["--dtk-col-accent" as string]: column.color,
        ["--dtk-col-tint" as string]: `${column.color}14`,
    } as React.CSSProperties;

    if (collapsed) {
        return (
            <div className="dtk-column dtk-column--collapsed" style={accentStyle}>
                <button
                    className="dtk-column__collapse-btn"
                    title={`Expand ${column.label}`}
                    onClick={() => onToggleCollapse(column.value)}
                >
                    ›
                </button>
                <div className="dtk-column--collapsed__label">
                    <span className="dtk-column__name">{column.label}</span>
                    <span className="dtk-column__count-pill">{column.cards.length}</span>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={setNodeRef}
            className={"dtk-column" + (isOver ? " dtk-column--over" : "")}
            style={accentStyle}
        >
            <div className="dtk-column__header">
                <div className="dtk-column__header-top">
                    <span className="dtk-column__name" title={column.label}>
                        {column.label}
                    </span>
                    <span className="dtk-column__count-pill">
                        {column.cards.length}/{totalCount}
                    </span>
                    <button
                        className="dtk-column__collapse-btn"
                        title={`Collapse ${column.label}`}
                        onClick={() => onToggleCollapse(column.value)}
                    >
                        ‹
                    </button>
                </div>
                <div className="dtk-column__sum">
                    {column.sumFormatted !== "" ? column.sumFormatted : "\u00A0"}
                </div>
            </div>

            <div
                className="dtk-column__body"
                onScroll={(e) => {
                    const el = e.currentTarget;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
                        onNearBottom();
                    }
                }}
            >
                {column.cards.length === 0 && (
                    <div className="dtk-column__empty">Drop a card here</div>
                )}
                {column.cards.map((card) => (
                    <KanbanCard
                        key={card.id}
                        card={card}
                        accentColor={column.color}
                        stageLabel={column.label}
                        onOpen={onOpen}
                        isSaving={savingIds.has(card.id)}
                        justMoved={card.id === justMovedId}
                    />
                ))}
            </div>
        </div>
    );
};