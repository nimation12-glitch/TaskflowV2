"""add system_settings table for maintenance mode

Revision ID: a7c2e91f5b3d
Revises: f3a9c1d8b274
Create Date: 2026-09-11 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7c2e91f5b3d'
down_revision: Union[str, Sequence[str], None] = 'f3a9c1d8b274'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'system_settings',
        sa.Column('maintenance_mode_enabled', sa.Boolean(), nullable=False),
        sa.Column('maintenance_message', sa.String(length=1000), nullable=True),
        sa.Column('updated_by_user_id', sa.UUID(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('system_settings')
