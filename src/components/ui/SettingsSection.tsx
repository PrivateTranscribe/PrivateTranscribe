import React from "react";

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  children,
  className = "",
}) => {
  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <h3 className="text-sm font-semibold text-foreground tracking-tight">{title}</h3>
        {description && (
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
};

interface SettingsGroupProps {
  title?: string;
  children: React.ReactNode;
  variant?: "default" | "highlighted";
  className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  children,
  variant = "default",
  className = "",
}) => {
  const baseClasses = "space-y-3 p-3 rounded-lg border";
  const variantClasses = {
    default: "bg-surface-2/50 border-border-subtle",
    highlighted: "bg-primary/10 border-primary/30",
  };

  return (
    <div className={`${baseClasses} ${variantClasses[variant]} ${className}`}>
      {title && <h4 className="text-[12px] font-medium text-foreground">{title}</h4>}
      {children}
    </div>
  );
};

interface SettingsRowProps {
  label: string;
  /** Node rather than string so a locked row can offer a way out inline. */
  description?: React.ReactNode;
  /** Rendered beside the label, e.g. a Beta pill on a tester-only control. */
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  description,
  badge,
  children,
  className = "",
}) => {
  return (
    // The label doubles as the row's address: settings search scrolls to
    // `[data-settings-label="..."]` after it switches tab or page. Tagging the
    // shared primitive keeps every row findable without touching any of them,
    // and a test pins the labels against the search index so the two cannot drift.
    <div
      data-settings-label={label}
      className={`flex items-center justify-between gap-4 ${className}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {badge}
        </div>
        {description && (
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
};
