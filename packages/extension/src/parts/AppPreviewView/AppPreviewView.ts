import {
  executeCommand,
  type View,
  type VirtualDomViewInstance,
} from '@lvce-editor/api'
import { VirtualDomElements } from '@lvce-editor/constants'
import type { AppPreview } from '../AppPreview/AppPreview.ts'

export const previewViewId = 'builtin.codespaces-preview'
let preview: AppPreview | undefined
const refreshers = new Set<() => Promise<void>>()

export const setAppPreview = async (
  value: AppPreview | undefined,
): Promise<void> => {
  preview = value
  await Promise.all([...refreshers].map((refresh) => refresh()))
}

export const previewView: View<VirtualDomViewInstance> = {
  id: previewViewId,
  kind: 'virtualDom',
  title: 'Application Preview',
  preferredLocation: 'preview',
  create: (context) => {
    let alternateFrame = false
    const refresh = async (): Promise<void> => {
      await context?.requestRerender()
    }
    refreshers.add(refresh)
    return {
      renderActionsDom: () => [],
      dispose: () => {
        refreshers.delete(refresh)
      },
      renderTitle: () => preview?.label || 'Application Preview',
      getCss:
        () => `.CodespacesPreview { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.CodespacesPreviewToolbar { display: flex; gap: 8px; padding: 8px; align-items: center; }
.CodespacesPreviewUrl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.CodespacesPreviewFrameContainer { display: flex; flex: 1; min-height: 0; }
.CodespacesPreviewFrame { flex: 1; width: 100%; min-height: 0; border: 0; background: white; }
.CodespacesPreviewHint { margin: 0; padding: 8px; }`,
      handleEvent: async (event) => {
        if (!preview) return
        const name = event.handler || event.name
        if (name === 'openPreviewInBrowser') {
          await executeCommand('Open.openUrl', preview.url, true)
        } else if (name === 'reloadPreview') {
          // Replace the frame's container to reload without changing the app URL
          // or triggering a nested render while this event is being dispatched.
          alternateFrame = !alternateFrame
        }
      },
      render: () => {
        const { Div, Section, Button, Text, Iframe } = VirtualDomElements
        return [
          {
            type: Div,
            className: 'CodespacesPreview',
            childCount: preview ? 3 : 2,
          },
          { type: Div, className: 'CodespacesPreviewToolbar', childCount: 3 },
          {
            type: Div,
            className: 'CodespacesPreviewUrl',
            title: preview?.url || 'Application Preview',
            childCount: 1,
          },
          {
            type: Text,
            childCount: 0,
            text: preview?.url || 'No connected application',
          },
          {
            type: Button,
            onClick: 'handleClick',
            name: 'reloadPreview',
            childCount: 1,
          },
          { type: Text, childCount: 0, text: 'Reload' },
          {
            type: Button,
            onClick: 'handleClick',
            name: 'openPreviewInBrowser',
            childCount: 1,
          },
          { type: Text, childCount: 0, text: 'Open in Browser' },
          { type: Div, className: 'CodespacesPreviewHint', childCount: 1 },
          {
            type: Text,
            childCount: 0,
            text: 'If the app is still starting, reload. For private ports, open in your browser to sign in to GitHub, then reload.',
          },
          ...(!preview
            ? []
            : [
                {
                  type: alternateFrame ? Section : Div,
                  className: 'CodespacesPreviewFrameContainer',
                  childCount: 1,
                },
                {
                  type: Iframe,
                  className: 'CodespacesPreviewFrame',
                  src: preview.url,
                  title: preview.label,
                  sandbox:
                    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
                  childCount: 0,
                },
              ]),
        ]
      },
    }
  },
}
