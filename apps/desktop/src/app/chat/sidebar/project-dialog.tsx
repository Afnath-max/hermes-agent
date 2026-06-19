import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import {
  $projectDialog,
  addProjectFolder,
  closeProjectDialog,
  createProject,
  pickProjectFolder,
  renameProject
} from '@/store/projects'

// Single dialog mounted once in the sidebar; it renders create / rename /
// add-folder flows driven by the $projectDialog atom. Folders are chosen via
// the native directory picker (reused from the default-project-dir setting).
export function ProjectDialog() {
  const { t } = useI18n()
  const p = t.sidebar.projects
  const state = useStore($projectDialog)
  const open = state !== null
  const mode = state?.mode ?? 'create'

  const [name, setName] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName(state?.name ?? '')
      setFolders([])
      setSubmitting(false)

      if (mode !== 'add-folder') {
        window.setTimeout(() => nameRef.current?.select(), 0)
      }
    }
  }, [open, mode, state?.name])

  const onOpenChange = (next: boolean) => {
    if (!next) {
      closeProjectDialog()
    }
  }

  const pickFolder = async () => {
    const dir = await pickProjectFolder()

    if (!dir) {
      return
    }

    if (mode === 'add-folder' && state?.projectId) {
      setSubmitting(true)

      try {
        await addProjectFolder(state.projectId, dir)
        closeProjectDialog()
      } catch (err) {
        notifyError(err, p.createFailed)
      } finally {
        setSubmitting(false)
      }

      return
    }

    setFolders(prev => (prev.includes(dir) ? prev : [...prev, dir]))
  }

  const submit = async () => {
    if (submitting) {
      return
    }

    const trimmed = name.trim()

    if (mode === 'rename' && state?.projectId) {
      if (!trimmed) {
        return
      }

      setSubmitting(true)

      try {
        await renameProject(state.projectId, trimmed)
        closeProjectDialog()
      } catch (err) {
        notifyError(err, p.createFailed)
      } finally {
        setSubmitting(false)
      }

      return
    }

    if (mode === 'create') {
      if (!trimmed) {
        return
      }

      setSubmitting(true)

      try {
        await createProject({ name: trimmed, folders, use: true })
        closeProjectDialog()
      } catch (err) {
        notifyError(err, p.createFailed)
      } finally {
        setSubmitting(false)
      }
    }
  }

  const title = mode === 'rename' ? p.renameTitle : mode === 'add-folder' ? p.addFolderTitle : p.createTitle

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {mode === 'create' && <DialogDescription>{p.createDesc}</DialogDescription>}
        </DialogHeader>

        {mode !== 'add-folder' && (
          <Input
            autoFocus
            disabled={submitting}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              } else if (event.key === 'Escape') {
                onOpenChange(false)
              }
            }}
            placeholder={p.namePlaceholder}
            ref={nameRef}
            value={name}
          />
        )}

        {mode === 'create' && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-(--ui-text-tertiary)">{p.foldersLabel}</span>
            {folders.length === 0 ? (
              <span className="text-[0.75rem] text-(--ui-text-quaternary)">{p.noFolders}</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {folders.map((folder, index) => (
                  <li
                    className={cn(
                      'flex items-center gap-2 rounded-md bg-(--ui-control-hover-background) px-2 py-1 text-[0.75rem]'
                    )}
                    key={folder}
                  >
                    <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="folder" size="0.75rem" />
                    <span className="min-w-0 flex-1 truncate" title={folder}>
                      {folder}
                    </span>
                    {index === 0 && (
                      <span className="shrink-0 text-[0.625rem] uppercase text-(--ui-text-quaternary)">
                        {p.primaryBadge}
                      </span>
                    )}
                    <Button
                      aria-label={p.removeFolder}
                      className="size-5 shrink-0 text-(--ui-text-quaternary) hover:text-foreground"
                      onClick={() => setFolders(prev => prev.filter(f => f !== folder))}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Codicon name="close" size="0.75rem" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              className="self-start"
              disabled={submitting}
              onClick={() => void pickFolder()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Codicon name="add" size="0.75rem" />
              {p.addFolder}
            </Button>
          </div>
        )}

        {mode === 'add-folder' && (
          <Button disabled={submitting} onClick={() => void pickFolder()} type="button">
            <Codicon name="folder-opened" size="0.875rem" />
            {p.addFolder}
          </Button>
        )}

        {mode !== 'add-folder' && (
          <DialogFooter>
            <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {t.common.cancel}
            </Button>
            <Button disabled={submitting || !name.trim()} onClick={() => void submit()} type="button">
              {mode === 'rename' ? t.common.save : p.create}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
