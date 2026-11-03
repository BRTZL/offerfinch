export interface MatchAlert {
	title: string;
	companyName: string;
	score: number;
	url: string;
	flags: string[];
}

export interface Notifier {
	notifyStrongMatch(alert: MatchAlert): Promise<void>;
}

export class NoopNotifier implements Notifier {
	readonly sent: MatchAlert[] = [];
	async notifyStrongMatch(alert: MatchAlert): Promise<void> {
		this.sent.push(alert);
	}
}
