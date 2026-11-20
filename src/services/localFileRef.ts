const PREFIX = 'local:'

export const toLocalFileRef = (id: string): string => `${PREFIX}${id}`

export const isLocalFileRef = (ref: string): boolean => ref.startsWith(PREFIX)
