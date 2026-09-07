export interface LocalFile { path: string; mimeType?: string; name?: string }
export interface MessageInput { text?: string; files?: LocalFile[]; onClientMessageId?: (id: string) => void }
