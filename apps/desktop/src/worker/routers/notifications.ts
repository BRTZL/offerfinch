import { notificationSettingsSchema } from "../settings";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

export const notificationsRouter = {
	get: protectedProcedure.handler(() => worker().settings.get("notifications")),
	set: protectedProcedure
		.input(notificationSettingsSchema)
		.handler(async ({ input }) => {
			await worker().setNotifications(input);
			return input;
		}),
};
