import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  createTRPCRouter,
  adminProcedure,
  publicProcedure,
  protectedWithUserProcedure,
  protectedProcedure,
} from "@/server/trpc";
import {
  UserLoginFormSchema,
  UserReadAdminSchema,
  UserReadSchema,
  UserUpdateSelfSchema,
  UserUpdatePasswordSchema,
} from "@/schema/user.schema";
import { hashPassword, verifyPassword } from "@/lib/password";
import { lucia } from "@/server/auth";
import { cookies } from "next/headers";
import { UserRole } from "@prisma/client";
import {
  UserGroupCreateInputSchema,
  UserOptionalDefaultsSchema,
  UserWhereUniqueInputSchema,
} from "@/schema/generated/zod";

export const userRouter = createTRPCRouter({
  login: publicProcedure.input(UserLoginFormSchema).mutation(async ({ ctx, input }) => {
    const user = await ctx.db.user.findUnique({ where: { username: input.username } });
    if (!user) {
      // Hash the password to prevent timing attacks
      // const _ = hashPassword(password);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Wrong username or password" });
    }
    const validPassword = await verifyPassword(input.password, user.hashedPassword);
    if (!validPassword) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Wrong username or password" });
    }
    const session = await lucia.createSession(user.id, {
      currentIp: undefined, // todo
    });
    const sessionCookie = lucia.createSessionCookie(session.id);
    cookies().set(sessionCookie);
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    const session = ctx.session;
    await lucia.invalidateSession(session.id);
    cookies().delete(lucia.sessionCookieName);
  }),

  create: adminProcedure
    .input(
      z.object({
        user: UserOptionalDefaultsSchema.omit({
          hashedPassword: true,
        }),
        group: UserGroupCreateInputSchema,
        password: z.string().min(6),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const hashedPassword = await hashPassword(input.password);
      const result = await ctx.db.user.create({
        data: { ...input.user, hashedPassword: hashedPassword },
        include: {
          group: true,
        },
      });
      return UserReadAdminSchema.parse(result);
    }),

  getSelf: protectedWithUserProcedure.query(async ({ ctx }) => {
    const user = ctx.user;
    return UserReadSchema.parse(user);
  }),

  get: adminProcedure.input(UserWhereUniqueInputSchema).query(async ({ ctx, input }) => {
    const user = await ctx.db.user.findFirst({ where: input });
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }
    return UserReadAdminSchema.parse(user);
  }),

  updateSelf: protectedWithUserProcedure.input(UserUpdateSelfSchema).mutation(async ({ ctx, input }) => {
    const user = ctx.user;
    const result = await ctx.db.user.update({
      where: {
        id: user.id,
      },
      data: {
        ...input,
      },
    });
    return UserReadSchema.parse(result);
  }),

  changePassword: protectedWithUserProcedure.input(UserUpdatePasswordSchema).mutation(async ({ ctx, input }) => {
    const hashedPassword = await hashPassword(input.password);

    if (ctx.user.role !== UserRole.ADMIN && input.id !== ctx.user.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You can only change your own password" });
    }

    return ctx.db.user.update({
      where: {
        id: input.id,
      },
      data: {
        hashedPassword,
      },
    });
  }),

  getAll: adminProcedure.query(async ({ ctx }) => {
    const users = await ctx.db.user.findMany({
      include: {
        group: true,
      },
    });
    return users.map((user) => UserReadAdminSchema.parse(user));
  }),
});
