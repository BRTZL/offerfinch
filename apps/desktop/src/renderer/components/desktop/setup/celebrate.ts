import { useCallback, useState } from "react";
import { desktop } from "@/lib/desktop";

/**
 * Setup's two moments (AI connected, the first matches): the app's chirp, when the chirp is the
 * chosen notification sound, and a sparkle burst (`SparkleBurst`, none under reduced motion).
 */
export function useCelebrate(): { burst: number; celebrate: () => void } {
	const [burst, setBurst] = useState(0);
	const celebrate = useCallback(() => {
		setBurst((n) => n + 1);
		desktop.notifications.chirp().catch(() => {});
	}, []);
	return { burst, celebrate };
}
