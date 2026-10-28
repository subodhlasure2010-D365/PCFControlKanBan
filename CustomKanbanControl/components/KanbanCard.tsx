import * as React from "react";
import { useDraggable } from "@dnd-kit/core";
import { KanbanCardData } from "../types";

export interface KanbanCardProps {
    card: KanbanCardData;
    accentColor: string;
    stageLabel: string;
    onOpen: (card: KanbanCardData) => void;
    isSaving: boolean;
    justMoved: boolean;
}

export const KanbanCard: React.FC<KanbanCardProps> = (props) => {
    const { card, onOpen, isSaving, accentColor, stageLabel, justMoved } = props;
    const [expanded, setExpanded] = React.useState(false);
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: card.id,
        data: { card },
    });

    const style: React.CSSProperties = { ["--dtk-accent" as string]: accentColor };
    if (transform) {
        style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0)`;
    }

    const className =
        "dtk-card" +
        (isDragging ? " dtk-card--dragging" : "") +
        (isSaving ? " dtk-card--saving" : "") +
        (justMoved ? " dtk-card--justmoved" : "") +
        (expanded ? " dtk-card--expanded" : "");

    const hasExtras = card.extraFields.length > 0;

    return (
        <div
            ref={setNodeRef}
            className={className}
            style={style}
            {...listeners}
            {...attributes}
        >
            <button
                className="dtk-card__title"
                title="Open record"
                onClick={(e) => {
                    e.stopPropagation();
                    onOpen(card);
                }}
            >
                {card.title}
            </button>

            <div className="dtk-card__meta">
                {card.ownerName !== "" ? (
                    <span className="dtk-card__owner" title={card.ownerName}>
                        <span
                            className="dtk-card__avatar"
                            style={{ backgroundColor: accentColor }}
                        >
                            {card.ownerInitials}
                        </span>
                        <span className="dtk-card__owner-name">{card.ownerName}</span>
                    </span>
                ) : (
                    <span className="dtk-card__tag">{stageLabel}</span>
                )}
                {hasExtras && (
                    <button
                        className="dtk-card__expand"
                        title={expanded ? "Show less" : "Show all fields"}
                        aria-label={expanded ? "Show less" : "Show all fields"}
                        aria-expanded={expanded}
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded((v) => !v);
                        }}
                    >
                        <span className="dtk-card__expand-icon">⌄</span>
                    </button>
                )}
            </div>

            {hasExtras && (
                <div className="dtk-card__fields">
                    {card.extraFields.map((f, i) => (
                        <div className="dtk-card__field" key={i}>
                            <span className="dtk-card__field-label" title={f.label}>
                                {f.label}
                            </span>
                            <span className="dtk-card__field-value" title={f.value}>
                                {f.value}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {(card.valueFormatted !== "" || card.dateFormatted !== "") && (
                <div className="dtk-card__footer">
                    {card.valueFormatted !== "" && (
                        <span className="dtk-card__value">{card.valueFormatted}</span>
                    )}
                    {card.dateFormatted !== "" && (
                        <span
                            className={
                                "dtk-card__date" + (card.isOverdue ? " dtk-card__date--overdue" : "")
                            }
                            title={card.isOverdue ? "Past due" : "Due date"}
                        >
                            {card.dateFormatted}
                        </span>
                    )}
                </div>
            )}
            {isSaving && <div className="dtk-card__saving-bar" />}
        </div>
    );
};

/** Non-interactive clone rendered inside the DragOverlay. */
export const KanbanCardGhost: React.FC<{ card: KanbanCardData; accentColor: string }> = ({
    card,
    accentColor,
}) => (
    <div
        className="dtk-card dtk-card--ghost"
        style={{ ["--dtk-accent" as string]: accentColor }}
    >
        <span className="dtk-card__title">{card.title}</span>
        <div className="dtk-card__meta">
            {card.ownerName !== "" && (
                <span className="dtk-card__owner">
                    <span className="dtk-card__avatar" style={{ backgroundColor: accentColor }}>
                        {card.ownerInitials}
                    </span>
                    <span className="dtk-card__owner-name">{card.ownerName}</span>
                </span>
            )}
        </div>
        {(card.valueFormatted !== "" || card.dateFormatted !== "") && (
            <div className="dtk-card__footer">
                {card.valueFormatted !== "" && (
                    <span className="dtk-card__value">{card.valueFormatted}</span>
                )}
                {card.dateFormatted !== "" && (
                    <span className="dtk-card__date">{card.dateFormatted}</span>
                )}
            </div>
        )}
    </div>
);