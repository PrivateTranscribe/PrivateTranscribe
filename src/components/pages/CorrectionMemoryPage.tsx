import { BookMarked } from "lucide-react";
import { Badge } from "../ui/badge";

export default function CorrectionMemoryPage() {
  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <BookMarked size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">
            Correction Memory
          </h1>
          <Badge variant="outline" className="text-[10px]">
            Coming Soon
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Train DictateVoice to remember your corrections
        </p>
      </div>

      {/* Skeleton content */}
      <div className="space-y-6 relative">
        {/* Skeleton card 1 */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="skeleton h-6 w-48" />
            <div className="skeleton h-8 w-24" />
          </div>
          <div className="space-y-2">
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-5/6" />
            <div className="skeleton h-4 w-4/6" />
          </div>
        </div>

        {/* Skeleton card 2 */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
          <div className="skeleton h-6 w-64" />
          <div className="grid grid-cols-2 gap-4">
            <div className="skeleton h-24" />
            <div className="skeleton h-24" />
          </div>
        </div>

        {/* Skeleton card 3 */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-32" />
                <div className="skeleton h-3 w-48" />
              </div>
              <div className="skeleton h-8 w-16" />
            </div>
            <div className="flex items-center gap-3">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-40" />
                <div className="skeleton h-3 w-56" />
              </div>
              <div className="skeleton h-8 w-16" />
            </div>
            <div className="flex items-center gap-3">
              <div className="skeleton h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-36" />
                <div className="skeleton h-3 w-44" />
              </div>
              <div className="skeleton h-8 w-16" />
            </div>
          </div>
        </div>

        {/* Skeleton card 4 - Input area */}
        <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-3">
          <div className="skeleton h-5 w-56" />
          <div className="flex gap-2">
            <div className="skeleton h-10 flex-1" />
            <div className="skeleton h-10 w-24" />
          </div>
        </div>

        {/* Coming Soon overlay */}
        <div className="absolute inset-0 bg-background/70 backdrop-blur-[2px] rounded-2xl flex items-center justify-center">
          <div className="text-center max-w-lg px-6">
            <Badge className="mb-4 px-5 py-2 text-base shadow-lg">Coming Soon</Badge>
            <h3 className="text-lg font-semibold text-foreground mb-3">
              Intelligent Correction Learning
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              This feature will learn from your manual corrections and automatically apply them in
              future transcriptions. Teach DictateVoice your preferred spellings, terminology, and
              phrasings.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
