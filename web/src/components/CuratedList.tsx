import { Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { prefetchCuratedTarget } from '@/lib/api'
import type { TargetIndexEntry } from '@/lib/types'
import { cn } from '@/lib/utils'

interface Props {
  targets: TargetIndexEntry[]
  selectedId: string | null
  loadingId: string | null
  onSelect: (entry: TargetIndexEntry) => void
}

export function CuratedList({ targets, selectedId, loadingId, onSelect }: Props) {
  return (
    <ul className="flex flex-col gap-1.5">
      {targets.map((t) => {
        const selected = t.id === selectedId
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t)}
              onPointerEnter={() => prefetchCuratedTarget(t)}
              onFocus={() => prefetchCuratedTarget(t)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                selected
                  ? 'border-primary/50 bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]'
                  : 'border-border hover:bg-muted',
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground capitalize">{t.kind}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {loadingId === t.id && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                <Badge variant="secondary">
                  {t.n_epochs} epoch{t.n_epochs === 1 ? '' : 's'}
                </Badge>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
