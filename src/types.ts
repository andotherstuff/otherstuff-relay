export type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: string]: any;
};

export type ClientMessage = 
  | ['EVENT', Event]
  | ['REQ', string, ...Filter[]]
  | ['CLOSE', string];

export type RelayMessage = 
  | ['EVENT', string, Event]
  | ['OK', string, boolean, string]
  | ['EOSE', string]
  | ['NOTICE', string];