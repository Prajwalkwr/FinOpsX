import { Prisma } from '@prisma/client'

/**
 * Creates a row whose readable public id is derived from a sequence, retrying with the next number
 * if a concurrent writer took the same id first.
 */
export async function createWithPublicId<T>(next: () => Promise<number>, format: (n: number) => string, create: (publicId: string) => Promise<T>): Promise<T> {
  const start = await next()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await create(format(start + attempt))
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue
      throw error
    }
  }
  return create(format(start + 6 + Math.floor(Math.random() * 1000)))
}
