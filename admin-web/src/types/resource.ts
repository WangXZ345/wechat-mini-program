export type CellKind = "text" | "money" | "status" | "number" | "date" | "role";

export interface TableColumnDefinition {
  key: string;
  label: string;
  kind?: CellKind;
  width?: number;
  minWidth?: number;
  sensitive?: boolean;
}

export interface FilterOption {
  label: string;
  value: string;
}

export interface ResourceActionDefinition {
  key: string;
  label: string;
  permission?: string;
  realEnabled?: boolean;
  type?: "primary" | "success" | "warning" | "danger" | "default";
  bulk?: boolean;
  confirmTitle?: string;
  confirmText?: string;
}

export interface ResourceDefinition {
  key: string;
  entityType: string;
  title: string;
  description: string;
  searchPlaceholder: string;
  columns: TableColumnDefinition[];
  statusOptions: FilterOption[];
  primaryAction?: ResourceActionDefinition;
  rowActions: ResourceActionDefinition[];
  bulkActions: ResourceActionDefinition[];
  readPermission: string;
  writePermission?: string;
  emptyText: string;
}
