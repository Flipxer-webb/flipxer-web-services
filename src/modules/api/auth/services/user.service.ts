import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

@Injectable()
export class UserService {
  async validateUser(email: string, password: string) {
    // Find the user by email, including their role
    const user = await prisma.user.findUnique({
      where: { email },
      include: { role: true }, // Include the role details
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if the user is active
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User is blocked or inactive');
    }

    // Compare the provided password with the hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Update last login time and increment login count
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date(), loginCount: user.loginCount + 1 },
    });

    // Return the user (excluding the password) and their role
    const { password: _, ...result } = user;
    return result;
  }
}