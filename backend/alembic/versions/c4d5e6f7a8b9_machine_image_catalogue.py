"""machine image catalogue + workspace image column

Revision ID: c4d5e6f7a8b9
Revises: b8e2f5a7c1d4
Create Date: 2026-11-18 18:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c4d5e6f7a8b9'
down_revision: Union[str, Sequence[str], None] = 'b8e2f5a7c1d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Schema-only: catalogue rows are DATA and are seeded by scripts/seed.py
    # so the seed stays re-runnable. Additive only.

    op.create_table(
        'machine_images',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('slug', sa.String(length=50), nullable=False),
        sa.Column('display_name', sa.String(length=100), nullable=False),
        sa.Column('description', sa.String(length=500), nullable=False),
        sa.Column('name_pattern', sa.String(length=200), nullable=False),
        sa.Column('ssm_parameter', sa.String(length=500), nullable=True),
        sa.Column('hourly_price_micros', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default=sa.text('0')),
    )
    op.create_index('ix_machine_images_slug', 'machine_images', ['slug'], unique=True)

    # The image a workspace boots rides along on the workspace (images are
    # never a separate flow). NULL = platform default image.
    op.add_column('workspaces', sa.Column('image_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        'fk_workspaces_image_id', 'workspaces', 'machine_images',
        ['image_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_workspaces_image_id', 'workspaces', type_='foreignkey')
    op.drop_column('workspaces', 'image_id')
    op.drop_index('ix_machine_images_slug', table_name='machine_images')
    op.drop_table('machine_images')
