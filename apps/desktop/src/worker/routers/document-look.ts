import { documentLookSchema } from "@offerfinch/core/export/look";
import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

/** The look of exported CVs and letters; read at each export, so a save needs nothing else. */
export const documentLookRouter = {
	get: protectedProcedure.handler(() => worker().settings.get("documentLook")),
	set: protectedProcedure
		.input(documentLookSchema)
		.handler(async ({ input }) => {
			await worker().settings.set("documentLook", input);
			return input;
		}),
};
