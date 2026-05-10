"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
import { EmptyState } from "./empty-state";

export function DataTable<T>({
  columns,
  data,
  emptyTitle,
  emptyMessage
}: {
  columns: ColumnDef<T>[];
  data: T[];
  emptyTitle: string;
  emptyMessage: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const parentRef = useRef<HTMLDivElement | null>(null);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8
  });

  if (!data.length) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />;
  }

  return (
    <div className="tableShell">
      <div className="tableHeader">
        {table.getHeaderGroups().map((headerGroup) =>
          headerGroup.headers.map((header) => (
            <button
              key={header.id}
              className="tableHeadCell"
              onClick={header.column.getToggleSortingHandler()}
              type="button"
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
              {header.column.getIsSorted() ? <span>{header.column.getIsSorted() === "asc" ? "Asc" : "Desc"}</span> : null}
            </button>
          ))
        )}
      </div>
      <div ref={parentRef} className="tableBody">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                className="tableRow"
                key={row.id}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div className="tableCell" key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
