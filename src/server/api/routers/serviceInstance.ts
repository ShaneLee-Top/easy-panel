import { TRPCError } from "@trpc/server";

import {
  createTRPCRouter,
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  protectedWithUserProcedure,
} from "@/server/trpc";
import { z } from "zod";
import {
  ServiceInstanceCreateSchema,
  ServiceInstanceAdminSchema,
  ServiceInstanceUpdateSchema,
  ServiceInstanceWithToken,
  ServiceInstanceUserReadSchema,
} from "@/schema/serviceInstance.schema";
import { resourceUsageLogs, serviceInstances, userInstanceAbilities, users } from "@/server/db/schema";
import { createCUID } from "@/lib/cuid";
import { and, eq } from "drizzle-orm";

export const serviceInstanceRouter = createTRPCRouter({
  create: adminProcedure.input(ServiceInstanceCreateSchema).mutation(async ({ ctx, input }) => {
    const result = await ctx.db
      .insert(serviceInstances)
      .values({
        id: createCUID(),
        ...input,
      })
      .returning();
    return ServiceInstanceAdminSchema.parse(result[0]);
  }),

  grantToAllActiveUsers: adminProcedure.input(z.object({ instanceId: z.string() })).mutation(async ({ ctx, input }) => {
    const userIds = await ctx.db.select({ id: users.id }).from(users).where(eq(users.isActive, true));
    await ctx.db.transaction(async (tx) => {
      for (const { id } of userIds) {
        await tx
          .insert(userInstanceAbilities)
          .values({
            userId: id,
            instanceId: input.instanceId,
            token: createCUID(),
            canUse: true,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [userInstanceAbilities.userId, userInstanceAbilities.instanceId],
            set: {
              canUse: true,
              updatedAt: new Date(),
            },
          });
      }
    });
  }),

  update: adminProcedure.input(ServiceInstanceUpdateSchema).mutation(async ({ ctx, input }) => {
    if (!input.id) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "ID is required" });
    }
    const result = await ctx.db
      .update(serviceInstances)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(serviceInstances.id, input.id))
      .returning();
    return ServiceInstanceAdminSchema.parse(result[0]);
  }),

  updateData: adminProcedure.input(ServiceInstanceUpdateSchema.pick({ id: true, data: true })).mutation(
    async ({ ctx, input }) => {
      if (!input.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "ID is required" });
      }
      const result = await ctx.db
        .update(serviceInstances)
        .set({
          data: input.data,
          updatedAt: new Date(),
        })
        .where(eq(serviceInstances.id, input.id))
        .returning();
      return ServiceInstanceAdminSchema.parse(result[0]);
    },
  ),

  getAllAdmin: adminProcedure.query(async ({ ctx }) => {
    const result = await ctx.db.query.serviceInstances.findMany();
    return ServiceInstanceAdminSchema.array().parse(result);
  }),

  getAllWithToken: protectedWithUserProcedure.query(async ({ ctx }) => {
    const user = ctx.user;
    const result = await ctx.db
      .select({
        serviceInstances,
        token: userInstanceAbilities.token,
      })
      .from(serviceInstances)
      .innerJoin(
        userInstanceAbilities,
        and(
          eq(userInstanceAbilities.instanceId, serviceInstances.id),
          eq(userInstanceAbilities.userId, user.id),
          eq(userInstanceAbilities.canUse, true),
        ),
      );
    const instances = result.map((r) => ({
      ...r.serviceInstances,
      token: r.token,
    }));
    return ServiceInstanceWithToken.array().parse(instances);
  }),

  getById: protectedProcedure.input(ServiceInstanceUserReadSchema.pick({ id: true })).query(async ({ ctx, input }) => {
    const result = await ctx.db.query.serviceInstances.findFirst({
      where: eq(serviceInstances.id, input.id),
    });
    if (!result) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Service instance not found" });
    }
    return ServiceInstanceUserReadSchema.parse(result);
  }),

  delete: adminProcedure
    .input(ServiceInstanceAdminSchema.pick({ id: true }).merge(z.object({ deleteLogs: z.boolean() })))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        await tx.delete(userInstanceAbilities).where(eq(userInstanceAbilities.instanceId, input.id));
        await tx.delete(serviceInstances).where(eq(serviceInstances.id, input.id));
        if (input.deleteLogs) {
          await tx.delete(resourceUsageLogs).where(eq(resourceUsageLogs.instanceId, input.id));
        }
      });
    }),

  verifyUserAbility: publicProcedure
    .input(
      z.object({
        instanceId: z.string(),
        userToken: z.string(),
        requestIp: z.string().ip().nullable(),
        userIp: z.string().ip().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const instanceToken = await ctx.db.query.userInstanceAbilities.findFirst({
        where: and(
          eq(userInstanceAbilities.instanceId, input.instanceId),
          eq(userInstanceAbilities.token, input.userToken),
        ),
      });
      if (!instanceToken) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid token" });
      }
      if (instanceToken.instanceId !== input.instanceId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid instanceId" });
      }
      if (instanceToken.canUse === false) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You are not permitted to use this instance" });
      }
      return instanceToken.userId;
    }),
});
